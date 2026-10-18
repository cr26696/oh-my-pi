/**
 * Settings declared by the RS-Mem-One memory backend.
 *
 * The backend shells out to the local `rs-mem-one` binary (a renamed
 * jev-mem-cli build) rather than embedding its SQLite/HTTP stack in the agent
 * process, so every setting here is passed to the CLI on each call.
 */
import { register } from "../config/registry";

const GROUP = "RS-Mem-One";

export const cfgRsmemBin = register({
	id: "rs-mem-one.bin",
	type: "string",
	default: "rs-mem-one",
	ui: {
		tab: "memory",
		group: GROUP,
		label: "RS-Mem-One Binary",
		description: "Path or name of the rs-mem-one CLI. Defaults to `rs-mem-one` on PATH.",
		condition: "rsmemActive",
	},
});

export const cfgRsmemTransport = register({
	id: "rs-mem-one.transport",
	type: "enum",
	values: ["stdio", "cli"] as const,
	default: "stdio",
	ui: {
		tab: "memory",
		group: GROUP,
		label: "RS-Mem-One Transport",
		description:
			"stdio keeps one resident `rs-mem-one serve` process per session; cli starts the one-shot binary per call.",
		options: [
			{
				value: "stdio",
				label: "Resident stdio",
				description: "One long-lived JSONL server; reuses SQLite, HTTP clients and the Jev decision cache",
			},
			{
				value: "cli",
				label: "One-shot CLI",
				description: "Run `rs-mem-one query/record/stats` for every request",
			},
		],
		condition: "rsmemActive",
	},
});

export const cfgRsmemDbPath = register({
	id: "rs-mem-one.dbPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: GROUP,
		label: "RS-Mem-One DB Path",
		description: "Optional SQLite database path passed as `--db`. Empty uses the CLI's own config.",
		condition: "rsmemActive",
	},
});

export const cfgRsmemConfigPath = register({
	id: "rs-mem-one.configPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: GROUP,
		label: "RS-Mem-One Config Path",
		description: "Optional explicit config file passed as `--config`.",
		condition: "rsmemActive",
	},
});

export const cfgRsmemTimeoutSeconds = register({
	id: "rs-mem-one.timeoutSeconds",
	type: "number",
	default: 20,
	ui: {
		tab: "memory",
		group: GROUP,
		label: "RS-Mem-One Timeout",
		description: "Per-invocation CLI timeout in seconds.",
		condition: "rsmemActive",
	},
});

export const cfgRsmemMaxEvidence = register({
	id: "rs-mem-one.maxEvidence",
	type: "number",
	default: 6,
	ui: {
		tab: "memory",
		group: GROUP,
		label: "RS-Mem-One Max Evidence",
		description: "Maximum evidence items returned by first-turn recall and `recall`.",
		condition: "rsmemActive",
	},
});

export const cfgRsmemInjectionTokenLimit = register({
	id: "rs-mem-one.injectionTokenLimit",
	type: "number",
	default: 5000,
	ui: {
		tab: "memory",
		group: GROUP,
		label: "RS-Mem-One Injection Budget",
		description: "Approximate token budget for the injected memory block.",
		condition: "rsmemActive",
	},
});

export const cfgRsmemAutoRecall = register({
	id: "rs-mem-one.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: GROUP,
		label: "RS-Mem-One Auto Recall",
		description: "Recall relevant graph evidence on the first turn of a top-level session.",
		condition: "rsmemActive",
	},
});

export const cfgRsmemDebug = register({
	id: "rs-mem-one.debug",
	type: "boolean",
	default: false,
});
