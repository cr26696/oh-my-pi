/**
 * RS-Mem-One memory backend.
 *
 * The backend delegates storage, embeddings and graph retrieval to the local
 * `rs-mem-one` CLI (the renamed jev-mem-cli). It owns only the session-scoped
 * first-turn recall and exposes the CLI's query/record/stats verbs through the
 * shared memory interface.
 */
import * as fs from "node:fs/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { findPersistedRecall, persistRecall, type PersistedRecall } from "../memory-backend/recall-entry";
import { memoryToolRefs } from "../memory-backend/tool-names";
import type {
	MemoryBackend,
	MemoryBackendSaveInput,
	MemoryBackendSearchItem,
	MemoryBackendSearchOptions,
	MemoryBackendStartOptions,
	MemoryBackendStatus,
	MemoryPromptPreparation,
} from "../memory-backend/types";
import rsmemInstructions from "../prompts/system/rsmem-instructions.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { loadRsmemConfig, type RsmemConfig } from "./config";
import {
	formatRsmemEvidence,
	getRsmemSessionState,
	type RsmemEvidence,
	RsmemSessionState,
	type RsmemStats,
	runRsmemJson,
	setRsmemSessionState,
	truncateRsmemText,
} from "./state";

const BACKEND_ID = "rs-mem-one" as const;

function recallScope(config: RsmemConfig): string {
	return `${BACKEND_ID}:${config.dbPath ?? "default"}`;
}

function formatRecallBlock(items: RsmemEvidence[]): string {
	const body = formatRsmemEvidence(items, { includeIds: true });
	return (
		`<rs_mem_one retrieved-at="${new Date().toISOString()}">\n` +
		"Automatically retrieved from the local RS-Mem-One knowledge graph. " +
		"Background context only: treat it as a lead, verify against the repository before acting, " +
		"and prefer newer evidence. Node ids are addressable with `memory://<node-id>`.\n" +
		`${body}\n</rs_mem_one>`
	);
}

function persistableRecall(items: RsmemEvidence[]): PersistedRecall {
	return {
		text: items.length > 0 ? formatRecallBlock(items) : "",
		memories: items
			.filter(item => typeof item.node_id === "string" && item.node_id.length > 0)
			.map(item => ({ id: item.node_id as string, text: item.content })),
	};
}

function renderStats(stats: RsmemStats): string {
	const linkTypes = Object.entries(stats.edges_by_link_type ?? {})
		.map(([name, count]) => `${name} ${count}`)
		.join(", ");
	const lines = [
		`### RS-Mem-One`,
		stats.db_path ? `- database: \`${stats.db_path}\`` : undefined,
		`- nodes: ${stats.nodes ?? 0}`,
		`- edges: ${stats.edges ?? 0}${linkTypes ? ` (${linkTypes})` : ""}`,
		`- fts rows: ${stats.fts_rows ?? 0}`,
		`- embedding dim: ${stats.embedding_dim ?? "unknown"}`,
		`- schema: ${stats.schema_version ?? "unknown"}`,
		`- journal: ${stats.journal_mode ?? "unknown"}`,
		`- latest: ${stats.latest_timestamp ?? "never"}`,
		`- database bytes: ${stats.database_bytes ?? 0}`,
	].filter((line): line is string => line !== undefined);
	return lines.join("\n");
}

async function resolveDbPath(config: RsmemConfig, cwd: string, session?: AgentSession): Promise<string | undefined> {
	const state = session ? getRsmemSessionState(session) : undefined;
	if (state?.dbPath) return state.dbPath;
	if (config.dbPath) return config.dbPath;
	const resolved = await runRsmemJson<{ db_path?: string }>(config, cwd, ["config"]);
	return resolved.db_path;
}

function summarizeCompactionMessages(messages: AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user" && typeof message.content === "string") {
			lines.push(`User: ${message.content}`);
			continue;
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const text = message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join("\n");
			if (text.trim()) lines.push(`Assistant: ${text}`);
		}
	}
	return lines.join("\n").slice(-6000);
}

export const rsmemBackend: MemoryBackend = {
	id: BACKEND_ID,

	async start(options: MemoryBackendStartOptions): Promise<void> {
		try {
			const config = loadRsmemConfig(options.settings);
			const state = new RsmemSessionState(options.session, config, options.taskDepth);
			const previous = setRsmemSessionState(options.session, state);
			previous?.dispose();
			await state.init();
		} catch (error) {
			logger.warn("RS-Mem-One: backend startup failed; memory backend inert.", { error: String(error) });
		}
	},

	async buildDeveloperInstructions(_agentDir, _cwd, _settings, session): Promise<string | undefined> {
		const rendered = prompt
			.render(rsmemInstructions, { toolRefs: memoryToolRefs(session?.getXdevToolEntries()) })
			.trim();
		return rendered || undefined;
	},

	async beforeAgentStartPrompt(
		session: AgentSession,
		promptText: string,
		signal?: AbortSignal,
	): Promise<MemoryPromptPreparation | undefined> {
		const state = getRsmemSessionState(session);
		if (!state || state.disposed || state.taskDepth > 0 || !state.config.autoRecall) return undefined;
		if (state.firstTurnDone) return undefined;

		const question = promptText.trim();
		if (question.length < 4) {
			state.markFirstTurn();
			return undefined;
		}

		const scope = recallScope(state.config);
		const persisted = findPersistedRecall(session.sessionManager, scope);
		if (persisted !== undefined) {
			state.markFirstTurn(persisted.text);
			return persisted.text
				? { context: persisted.text, commit: () => getRsmemSessionState(session) === state }
				: undefined;
		}

		try {
			const items = await state.query(question, { topK: state.config.maxEvidence, signal });
			const recall = persistableRecall(items);
			if (items.length === 0) {
				return {
					commit: () => {
						if (getRsmemSessionState(session) !== state) return false;
						state.markFirstTurn();
						persistRecall(session.sessionManager, scope, recall);
						return true;
					},
				};
			}
			const block = truncateRsmemText(recall.text, state.config.injectionTokenLimit);
			return {
				context: block,
				commit: () => {
					if (getRsmemSessionState(session) !== state) return false;
					state.markFirstTurn(block);
					persistRecall(session.sessionManager, scope, { ...recall, text: block });
					return true;
				},
			};
		} catch (error) {
			logger.warn("RS-Mem-One: first-turn recall skipped", { error: String(error) });
			state.markFirstTurn();
			return undefined;
		}
	},

	async preCompactionContext(messages, _settings, session): Promise<string | undefined> {
		const state = session ? getRsmemSessionState(session) : undefined;
		if (!state || state.disposed) return undefined;
		const query = summarizeCompactionMessages(messages);
		if (query.trim().length < 16) return undefined;
		try {
			const items = await state.query(query, { topK: Math.min(state.config.maxEvidence, 4) });
			if (items.length === 0) return undefined;
			const body = formatRsmemEvidence(items, {
				heading: "Relevant durable memory (RS-Mem-One evidence, background context only):",
			});
			return truncateRsmemText(body, state.config.injectionTokenLimit);
		} catch (error) {
			logger.warn("RS-Mem-One: compaction recall skipped", { error: String(error) });
			return undefined;
		}
	},

	async clear(_agentDir, cwd, session): Promise<void> {
		if (!session) throw new Error("RS-Mem-One clear requires an active session.");
		const config = loadRsmemConfig(session.settings);
		const state = getRsmemSessionState(session);
		state?.stopServer();
		const dbPath = await resolveDbPath(config, cwd, session);
		if (!dbPath) throw new Error("RS-Mem-One database path is unknown; set rs-mem-one.dbPath.");
		await Promise.all([
			fs.rm(dbPath, { force: true }),
			fs.rm(`${dbPath}-wal`, { force: true }),
			fs.rm(`${dbPath}-shm`, { force: true }),
		]);
		await runRsmemJson(config, cwd, ["init"]);
		state?.resetFirstTurn();
		logger.info("RS-Mem-One: memory cleared", { database: dbPath });
	},

	async enqueue(): Promise<void> {
		// The CLI judges and commits relations synchronously in `record`; there is
		// no pending queue to flush. `/memory enqueue` is therefore a no-op.
	},

	async status({ session }): Promise<MemoryBackendStatus> {
		const state = session ? getRsmemSessionState(session) : undefined;
		if (!state) {
			return {
				backend: BACKEND_ID,
				active: false,
				writable: false,
				searchable: false,
				message: "RS-Mem-One backend is not initialised for this session.",
			};
		}
		try {
			const stats = await state.stats();
			return {
				backend: BACKEND_ID,
				active: true,
				writable: true,
				searchable: true,
				scope: "global",
				workingCount: stats.nodes,
				tripleCount: stats.edges,
				lastRecall: state.lastRecall !== undefined,
				database: stats.db_path ?? state.dbPath,
				message: "Local RS-Mem-One graph is active.",
			};
		} catch (error) {
			return {
				backend: BACKEND_ID,
				active: true,
				writable: true,
				searchable: true,
				scope: "global",
				database: state.dbPath,
				error: String(error),
				message: "RS-Mem-One is running but its database could not be inspected.",
			};
		}
	},

	async search({ session }, query, options?: MemoryBackendSearchOptions) {
		const state = session ? getRsmemSessionState(session) : undefined;
		if (!state) {
			return {
				backend: BACKEND_ID,
				query,
				count: 0,
				items: [],
				message: "RS-Mem-One backend is not initialised for this session.",
			};
		}
		const limit = Math.max(1, Math.min(Math.trunc(options?.limit ?? state.config.maxEvidence), 20));
		if (options?.signal?.aborted) {
			return { backend: BACKEND_ID, query, count: 0, items: [], message: "Search aborted." };
		}
		const evidence = await state.query(query, { topK: limit, signal: options?.signal });
		const items: MemoryBackendSearchItem[] = evidence.map(item => ({
			id: item.node_id,
			content: item.content,
			source: "rs-mem-one",
			timestamp: item.timestamp,
			score: item.similarity ?? item.score,
		}));
		return { backend: BACKEND_ID, query, count: items.length, items };
	},

	async save({ session }, input: MemoryBackendSaveInput) {
		const state = session ? getRsmemSessionState(session) : undefined;
		if (!state) {
			return {
				backend: BACKEND_ID,
				stored: 0,
				message: "RS-Mem-One backend is not initialised for this session.",
			};
		}
		const content = input.content.trim();
		if (!content) return { backend: BACKEND_ID, stored: 0, message: "Memory content is empty." };
		try {
			const result = await state.record(content, {
				context: input.context,
				source: input.source || "coding-agent-memory-command",
			});
			return {
				backend: BACKEND_ID,
				stored: 1,
				ids: result.node_id ? [result.node_id] : undefined,
			};
		} catch (error) {
			return {
				backend: BACKEND_ID,
				stored: 0,
				message: `RS-Mem-One did not store the memory: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	},

	async stats(_agentDir, _cwd, session): Promise<string | undefined> {
		const state = session ? getRsmemSessionState(session) : undefined;
		if (!state) return undefined;
		try {
			return renderStats(await state.stats());
		} catch (error) {
			return `RS-Mem-One stats failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	},

	async diagnose(_agentDir, cwd, session): Promise<string | undefined> {
		const state = session ? getRsmemSessionState(session) : undefined;
		const config = session ? loadRsmemConfig(session.settings) : undefined;
		if (!state && !config) return undefined;
		const dbPath = state?.dbPath ?? (config ? await resolveDbPath(config, cwd, session) : undefined);
		const lines = [`### RS-Mem-One diagnostics`, `- database: \`${dbPath ?? "unknown"}\``];
		if (dbPath) {
			try {
				const stat = await fs.stat(dbPath);
				lines.push(`- file: ${stat.size} bytes, modified ${stat.mtime.toISOString()}`);
			} catch (error) {
				lines.push(`- file: unavailable (${error instanceof Error ? error.message : String(error)})`);
			}
		}
		if (state) {
			try {
				const stats = await state.stats();
				lines.push(
					`- nodes: ${stats.nodes ?? 0}`,
					`- edges: ${stats.edges ?? 0}`,
					`- fts rows: ${stats.fts_rows ?? 0}`,
					`- schema: ${stats.schema_version ?? "unknown"}`,
					`- journal: ${stats.journal_mode ?? "unknown"}`,
				);
			} catch (error) {
				lines.push(`- stats failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return lines.join("\n");
	},

	async applySettings(session, changed): Promise<void> {
		const state = getRsmemSessionState(session);
		if (!state) return;
		const config = loadRsmemConfig(session.settings);
		const connectionChanged = changed.some(
			id =>
				id === "rs-mem-one.bin" ||
				id === "rs-mem-one.dbPath" ||
				id === "rs-mem-one.configPath" ||
				id === "rs-mem-one.transport",
		);
		state.updateConfig(config);
		if (connectionChanged) {
			state.stopServer();
			await state.init();
			state.resetFirstTurn();
		}
		if (changed.some(id => id === "rs-mem-one.injectionTokenLimit" || id === "rs-mem-one.autoRecall")) {
			await session.refreshBaseSystemPrompt();
		}
	},
};
