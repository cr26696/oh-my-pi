/**
 * Per-session RS-Mem-One state and CLI transport.
 *
 * The CLI is a single-shot process; state here only holds the first-turn
 * recall plus the resolved database path (needed by `memory://<id>`).
 */
import { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { rsmemGlobalArgs, type RsmemConfig } from "./config";
import { RsmemServer, RsmemServerError } from "./server";

export interface RsmemEvidence {
	content: string;
	timestamp?: string;
	score?: number;
	similarity?: number;
	hop_depth?: number;
	node_id?: string;
	path_relations?: unknown[];
	entities?: string[];
}

export interface RsmemQueryResult {
	evidence?: RsmemEvidence[];
	meta?: {
		stopping_decision?: string;
		jev_calls?: number;
		latency_ms?: number;
	};
	error?: string;
	message?: string;
}

export interface RsmemRecordResult {
	node_id?: string;
	edge_count?: number;
	edges?: Array<{ link_type: string; sub_type: string; confidence: number }>;
	rejected?: unknown[];
	error?: string;
	message?: string;
}

export interface RsmemStats {
	database_bytes?: number;
	db_path?: string;
	distinct_entities?: number;
	earliest_timestamp?: string;
	edges?: number;
	edges_by_link_type?: Record<string, number>;
	edges_by_sub_type?: Record<string, number>;
	embedding_dim?: number;
	fts_rows?: number;
	journal_mode?: string;
	latest_timestamp?: string;
	nodes?: number;
	page_size?: number;
	schema_version?: number;
	error?: string;
	message?: string;
}

export interface RsmemStoredNode {
	id: string;
	content: string;
	timestamp: string;
	metadata: Record<string, unknown> | null;
	createdAt: number;
}

const kRsmemSessionState = Symbol("rsmem.sessionState");

interface AgentSessionWithRsmemState extends AgentSession {
	[kRsmemSessionState]?: RsmemSessionState;
}

export class RsmemCliError extends Error {
	readonly code: number;
	readonly stderr: string;

	constructor(message: string, code: number, stderr: string) {
		super(message);
		this.name = "RsmemCliError";
		this.code = code;
		this.stderr = stderr;
	}
}

function parseJson<T>(text: string): T | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			return JSON.parse(trimmed.slice(start, end + 1)) as T;
		} catch {
			return undefined;
		}
	}
}

/** Run one CLI invocation and parse its JSON stdout. */
export async function runRsmemJson<T>(
	config: RsmemConfig,
	cwd: string,
	args: string[],
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`rs-mem-one timed out after ${config.timeoutMs}ms`)),
		options.timeoutMs ?? config.timeoutMs,
	);
	const onAbort = () => controller.abort(options.signal?.reason);
	if (options.signal) {
		if (options.signal.aborted) controller.abort(options.signal.reason);
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn([config.bin, ...rsmemGlobalArgs(config), ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
		});
	} catch (error) {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		throw error;
	}
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);
		if (code !== 0) {
			const parsed = parseJson<{ message?: string; error?: string }>(stdout);
			throw new RsmemCliError(
				parsed?.message || parsed?.error || stderr.trim() || `rs-mem-one exited with ${code}`,
				code,
				stderr,
			);
		}
		const parsed = parseJson<T>(stdout);
		if (parsed === undefined) {
			throw new RsmemCliError(`rs-mem-one returned non-JSON output: ${stdout.trim().slice(0, 200)}`, code, stderr);
		}
		return parsed;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export class RsmemSessionState {
	readonly session: AgentSession;
	readonly taskDepth: number;
	config: RsmemConfig;
	dbPath: string | undefined;
	firstTurnDone = false;
	lastRecall: string | undefined;
	disposed = false;
	readonly server: RsmemServer;
	#serverDisabled = false;

	constructor(session: AgentSession, config: RsmemConfig, taskDepth: number) {
		this.session = session;
		this.config = config;
		this.taskDepth = taskDepth;
		this.server = new RsmemServer(config, session.sessionManager.getCwd());
	}

	updateConfig(config: RsmemConfig): void {
		const transportChanged = config.transport !== this.config.transport;
		this.config = config;
		this.server.updateConfig(config, this.session.sessionManager.getCwd());
		if (transportChanged) this.#serverDisabled = false;
	}

	#useServer(): boolean {
		return this.config.transport === "stdio" && !this.#serverDisabled;
	}

	async #call<T>(
		method: string,
		params: Record<string, unknown>,
		cliArgs: string[],
		options: { signal?: AbortSignal } = {},
	): Promise<T> {
		if (this.#useServer()) {
			try {
				return await this.server.request<T>(method, params, { signal: options.signal });
			} catch (error) {
				if (error instanceof RsmemServerError) throw error;
				logger.warn("RS-Mem-One: resident server failed; falling back to one-shot CLI", {
					error: String(error),
				});
				this.#serverDisabled = true;
			}
		}
		return await runRsmemJson<T>(this.config, this.session.sessionManager.getCwd(), cliArgs, {
			signal: options.signal,
		});
	}

	async init(): Promise<void> {
		if (this.#useServer()) {
			try {
				const resolved = await this.server.request<{ db_path?: string }>("config", {}, { timeoutMs: 5000 });
				if (typeof resolved.db_path === "string") this.dbPath = resolved.db_path;
				return;
			} catch (error) {
				if (error instanceof RsmemServerError) throw error;
				logger.warn("RS-Mem-One: resident server unavailable; using one-shot CLI", { error: String(error) });
				this.#serverDisabled = true;
			}
		}
		const resolved = await runRsmemJson<{ db_path?: string }>(this.config, this.session.sessionManager.getCwd(), [
			"config",
		]);
		if (typeof resolved.db_path === "string") this.dbPath = resolved.db_path;
	}

	markFirstTurn(text?: string): void {
		this.firstTurnDone = true;
		this.lastRecall = text;
	}

	resetFirstTurn(): void {
		this.firstTurnDone = false;
		this.lastRecall = undefined;
	}

	async query(question: string, options: { topK?: number; signal?: AbortSignal } = {}): Promise<RsmemEvidence[]> {
		const topK = options.topK ?? this.config.maxEvidence;
		const result = await this.#call<RsmemQueryResult>(
			"query",
			{ question, topK, hopping: true },
			["query", question, "--top-k", String(topK)],
			{ signal: options.signal },
		);
		return (result.evidence ?? []).filter(item => typeof item.content === "string" && item.content.trim());
	}

	async record(
		content: string,
		options: { context?: string; source?: string; signal?: AbortSignal } = {},
	): Promise<RsmemRecordResult> {
		const cwd = this.session.sessionManager.getCwd();
		const source = options.source || "omp:rs-mem-one";
		const sessionId = this.session.sessionManager.getSessionId();
		const meta: Record<string, string> = { cwd };
		if (sessionId) meta.session = sessionId;
		if (options.context?.trim()) meta.context = options.context.trim();
		const args = ["record", content.trim(), "--source", source];
		for (const [key, value] of Object.entries(meta)) args.push("--meta", `${key}=${value}`);
		return await this.#call<RsmemRecordResult>("record", { content: content.trim(), source, meta }, args, {
			signal: options.signal,
		});
	}

	async stats(): Promise<RsmemStats> {
		return await this.#call<RsmemStats>("stats", {}, ["stats"]);
	}

	/** Read one full node by id directly from the SQLite graph. */
	getMemoryById(id: string): RsmemStoredNode | null {
		if (!this.dbPath) return null;
		const db = new Database(this.dbPath, { readonly: true });
		try {
			const row = db
				.query("SELECT id, content, timestamp, metadata, created_at FROM nodes WHERE id = ?")
				.get(id) as {
				id: string;
				content: string;
				timestamp: string;
				metadata: string | null;
				created_at: number;
			} | null;
			if (!row) return null;
			let metadata: Record<string, unknown> | null = null;
			if (row.metadata) {
				try {
					metadata = JSON.parse(row.metadata) as Record<string, unknown>;
				} catch {
					metadata = { raw: row.metadata };
				}
			}
			return {
				id: row.id,
				content: row.content,
				timestamp: row.timestamp,
				metadata,
				createdAt: row.created_at,
			};
		} finally {
			db.close();
		}
	}

	stopServer(): void {
		this.#serverDisabled = false;
		void this.server.stop();
	}

	dispose(): void {
		this.disposed = true;
		this.lastRecall = undefined;
		void this.server.stop();
	}
}

export function getRsmemSessionState(session: AgentSession | undefined): RsmemSessionState | undefined {
	return session ? (session as AgentSessionWithRsmemState)[kRsmemSessionState] : undefined;
}

export function setRsmemSessionState(
	session: AgentSession,
	state: RsmemSessionState | undefined,
): RsmemSessionState | undefined {
	const holder = session as AgentSessionWithRsmemState;
	const previous = holder[kRsmemSessionState];
	if (state) holder[kRsmemSessionState] = state;
	else delete holder[kRsmemSessionState];
	return previous;
}

export function takeRsmemSessionState(session: AgentSession): RsmemSessionState | undefined {
	return setRsmemSessionState(session, undefined);
}

/** Compact one-line evidence list used by prompt injection and tools. */
export function formatRsmemEvidence(
	items: RsmemEvidence[],
	options: { heading?: string; includeIds?: boolean } = {},
): string {
	const lines = items.map(item => {
		const when = item.timestamp ?? "unknown-time";
		const hop = item.hop_depth ? ` hop=${item.hop_depth}` : "";
		const similarity = typeof item.similarity === "number" ? ` sim=${item.similarity.toFixed(3)}` : "";
		const id = options.includeIds && item.node_id ? ` (node ${item.node_id})` : "";
		return `- [${when}]${hop}${similarity}${id} ${item.content.replace(/\s+/g, " ").trim()}`;
	});
	return options.heading ? `${options.heading}\n${lines.join("\n")}` : lines.join("\n");
}

export function truncateRsmemText(text: string, tokenLimit: number): string {
	const charLimit = Math.max(0, tokenLimit) * 4;
	if (text.length <= charLimit) return text;
	const cut = text.slice(0, charLimit);
	const line = cut.lastIndexOf("\n");
	return `${line > 0 ? cut.slice(0, line) : cut}\n…`;
}
