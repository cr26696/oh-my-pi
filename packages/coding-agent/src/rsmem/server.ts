/**
 * Resident `rs-mem-one serve` client.
 *
 * One JSON request per stdin line, one JSON response per stdout line. The
 * process owns the SQLite handle, HTTP clients and the Jev decision cache, so
 * omp pays process startup, schema inspection and TLS setup once per session
 * instead of once per call.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { rsmemGlobalArgs, type RsmemConfig } from "./config";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: Timer;
}

interface ServeMessage {
	id?: unknown;
	ok?: boolean;
	result?: unknown;
	error?: { kind?: string; message?: string; exitCode?: number };
}

export class RsmemServerError extends Error {
	readonly kind: string;
	readonly exitCode: number;

	constructor(message: string, kind: string, exitCode: number) {
		super(message);
		this.name = "RsmemServerError";
		this.kind = kind;
		this.exitCode = exitCode;
	}
}

export class RsmemServer {
	#config: RsmemConfig;
	#cwd: string;
	#proc: Bun.Subprocess | undefined;
	#pending = new Map<string, PendingRequest>();
	#nextId = 0;
	#starting: Promise<void> | undefined;

	constructor(config: RsmemConfig, cwd: string) {
		this.#config = config;
		this.#cwd = cwd;
	}

	updateConfig(config: RsmemConfig, cwd: string): void {
		const changed =
			config.bin !== this.#config.bin ||
			config.dbPath !== this.#config.dbPath ||
			config.configPath !== this.#config.configPath ||
			config.transport !== this.#config.transport ||
			cwd !== this.#cwd;
		this.#config = config;
		this.#cwd = cwd;
		if (changed) void this.restart();
	}

	async restart(): Promise<void> {
		await this.stop();
	}

	async request<T>(
		method: string,
		params: Record<string, unknown> = {},
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<T> {
		await this.#ensure();
		const id = ++this.#nextId;
		const key = String(id);
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => {
			this.#pending.delete(key);
			reject(new Error(`rs-mem-one ${method} timed out after ${options.timeoutMs ?? this.#config.timeoutMs}ms`));
			void this.stop();
		}, options.timeoutMs ?? this.#config.timeoutMs);
		const onAbort = () => {
			this.#pending.delete(key);
			clearTimeout(timer);
			reject(new Error(`rs-mem-one ${method} aborted`));
		};
		if (options.signal) {
			if (options.signal.aborted) {
				clearTimeout(timer);
				throw new Error(`rs-mem-one ${method} aborted`);
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
		this.#pending.set(key, {
			timer,
			resolve: value => {
				options.signal?.removeEventListener("abort", onAbort);
				clearTimeout(timer);
				resolve(value as T);
			},
			reject: error => {
				options.signal?.removeEventListener("abort", onAbort);
				clearTimeout(timer);
				reject(error);
			},
		});
		const proc = this.#proc;
		if (!proc) {
			this.#pending.delete(key);
			clearTimeout(timer);
			reject(new Error("rs-mem-one serve is not running"));
			return promise;
		}
		const stdin = proc.stdin;
		if (!stdin || typeof stdin === "number") {
			this.#pending.delete(key);
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(new Error("rs-mem-one serve has no stdin pipe"));
			return promise;
		}
		try {
			stdin.write(`${JSON.stringify({ id, method, params })}\n`);
			await stdin.flush();
		} catch (error) {
			this.#pending.delete(key);
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	async stop(): Promise<void> {
		const proc = this.#proc;
		this.#proc = undefined;
		this.#starting = undefined;
		this.#failAll(new Error("rs-mem-one serve stopped"));
		if (!proc) return;
		const stdin = proc.stdin;
		try {
			if (stdin && typeof stdin !== "number") {
				stdin.write(`${JSON.stringify({ id: 0, method: "shutdown" })}\n`);
				await stdin.flush();
				stdin.end();
			}
		} catch {
			// The process may already be gone; the kill below is the fallback.
		}
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// Already exited.
			}
		}, 500);
		await Promise.race([proc.exited, Bun.sleep(600)]);
		clearTimeout(timer);
	}

	async #ensure(): Promise<void> {
		if (this.#proc) return;
		if (this.#starting) return this.#starting;
		this.#starting = (async () => {
			const proc = Bun.spawn([this.#config.bin, ...rsmemGlobalArgs(this.#config), "serve"], {
				cwd: this.#cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			this.#proc = proc;
			void this.#readStdout(proc);
			void this.#readStderr(proc);
			void proc.exited.then(() => this.#handleExit(proc));
		})();
		try {
			await this.#starting;
		} finally {
			this.#starting = undefined;
		}
	}

	async #readStdout(proc: Bun.Subprocess): Promise<void> {
		const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) this.#handleLine(line);
				newline = buffer.indexOf("\n");
			}
		}
	}

	async #readStderr(proc: Bun.Subprocess): Promise<void> {
		const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true }).trim();
			if (text) logger.debug("rs-mem-one serve", { line: text });
		}
	}

	#handleLine(line: string): void {
		let message: ServeMessage;
		try {
			message = JSON.parse(line) as ServeMessage;
		} catch (error) {
			logger.warn("rs-mem-one serve: invalid response", { error: String(error), line });
			return;
		}
		const key = String(message.id);
		const pending = this.#pending.get(key);
		if (!pending) {
			logger.debug("rs-mem-one serve: response without a pending request", { id: message.id });
			return;
		}
		this.#pending.delete(key);
		if (message.ok) {
			pending.resolve(message.result);
			return;
		}
		pending.reject(
			new RsmemServerError(
				message.error?.message ?? "rs-mem-one request failed",
				message.error?.kind ?? "server_error",
				message.error?.exitCode ?? 1,
			),
		);
	}

	#handleExit(proc: Bun.Subprocess): void {
		if (this.#proc === proc) this.#proc = undefined;
		this.#failAll(new Error("rs-mem-one serve exited"));
	}

	#failAll(error: Error): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
	}
}
