/** Resolved settings for one RS-Mem-One CLI invocation. */
import type { Settings } from "../config/settings";
import {
	cfgRsmemAutoRecall,
	cfgRsmemBin,
	cfgRsmemConfigPath,
	cfgRsmemDbPath,
	cfgRsmemDebug,
	cfgRsmemInjectionTokenLimit,
	cfgRsmemMaxEvidence,
	cfgRsmemTimeoutSeconds,
	cfgRsmemTransport,
} from "./settings";

export type RsmemTransport = "stdio" | "cli";

export interface RsmemConfig {
	bin: string;
	transport: RsmemTransport;
	dbPath?: string;
	configPath?: string;
	timeoutMs: number;
	maxEvidence: number;
	injectionTokenLimit: number;
	autoRecall: boolean;
	debug: boolean;
}

export function loadRsmemConfig(settings: Settings): RsmemConfig {
	const dbPath = cfgRsmemDbPath.get(settings)?.trim();
	const configPath = cfgRsmemConfigPath.get(settings)?.trim();
	const timeoutSeconds = cfgRsmemTimeoutSeconds.get(settings);
	return {
		bin: cfgRsmemBin.get(settings)?.trim() || "rs-mem-one",
		transport: cfgRsmemTransport.get(settings),
		dbPath: dbPath || undefined,
		configPath: configPath || undefined,
		timeoutMs: Math.max(1, Math.round(timeoutSeconds * 1000)),
		maxEvidence: Math.max(1, Math.round(cfgRsmemMaxEvidence.get(settings))),
		injectionTokenLimit: Math.max(1, Math.round(cfgRsmemInjectionTokenLimit.get(settings))),
		autoRecall: cfgRsmemAutoRecall.get(settings),
		debug: cfgRsmemDebug.get(settings),
	};
}

/** CLI arguments shared by every subcommand. */
export function rsmemGlobalArgs(config: RsmemConfig): string[] {
	const args: string[] = [];
	if (config.configPath) args.push("--config", config.configPath);
	if (config.dbPath) args.push("--db", config.dbPath);
	if (config.debug) args.push("--verbose");
	return args;
}
