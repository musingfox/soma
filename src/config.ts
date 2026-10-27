import { existsSync, readFileSync, statSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AuthContext, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { z } from "zod";
import { defaultRexSocket } from "./adapters/rex/client.ts";
import type { TelegramConfig } from "./adapters/telegram/index.ts";
import type { WebConfig } from "./adapters/web/index.ts";

/** The canonical form of a BCP 47 language tag, or undefined when it is not one. */
function canonicalLanguage(tag: string): string | undefined {
	try {
		return Intl.getCanonicalLocales(tag)[0];
	} catch {
		return undefined;
	}
}

/** The agent-side adapters soma can dispatch through; the config picks one. */
export const AGENT_ADAPTERS = ["herdr", "rex", "tty"] as const;
export type AgentAdapter = (typeof AGENT_ADAPTERS)[number];

/** The hangar is a rex session found by its id, never by its label, which rex does not keep unique. */
export interface RexConfig {
	readonly sessionId: string;
	readonly socket: string;
}

// Checked only when rex is selected, so a herdr setup never trips over a rex block it does not use.
const RexFileConfig = z
	.object({ sessionId: z.string().min(1), socket: z.string().min(1) })
	.partial()
	.strict();

const FileConfig = z
	.object({
		herdrSocket: z.string().min(1),
		mcpConfig: z.string().min(1),
		db: z.string().min(1),
		model: z.string().min(1),
		language: z.string().refine((tag) => canonicalLanguage(tag) !== undefined, "Expected a BCP 47 language tag"),
		hangarCap: z.number().int().positive(),
		programStatus: z.boolean(),
		repo: z.string().min(1),
		reflection: z.boolean(),
		agentAdapter: z.enum(AGENT_ADAPTERS),
		rex: z.unknown(),
		anthropic: z
			.object({ apiKey: z.string().min(1) })
			.partial()
			.strict(),
		exa: z
			.object({ apiKey: z.string().min(1) })
			.partial()
			.strict(),
		telegram: z
			.object({ botToken: z.string().min(1), chatId: z.number().int().safe(), apiBase: z.string().url() })
			.partial()
			.strict(),
		web: z
			.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) })
			.partial()
			.strict(),
	})
	.partial()
	.strict();
export type FileConfig = z.infer<typeof FileConfig>;

export interface Config {
	readonly agentAdapter: AgentAdapter;
	readonly herdrSocket: string;
	/** Set exactly when `agentAdapter` is rex. */
	readonly rex?: RexConfig;
	readonly mcpConfig: string;
	readonly db: string;
	readonly model: string;
	/** The BCP 47 tag of the language soma answers the human in. */
	readonly language: string;
	/** Unset: performance cores minus two, see hangar-cap.ts. */
	readonly hangarCap?: number;
	/** Unset: ask the terminal whether it supports OSC 7501. */
	readonly programStatus?: boolean;
	/** soma's own repository: the reflection's code-change cards go to the vault project its `.obsidian.yaml` names. */
	readonly repo: string;
	readonly reflection: boolean;
	readonly anthropicApiKey?: string;
	readonly exaApiKey?: string;
	/** Set only when both a bot token and a chat id are. */
	readonly telegram?: TelegramConfig;
	/** Set only when both a host and a port are; the host is a tailnet address. */
	readonly web?: WebConfig;
}

type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {}

/** Unset, it is prod's file: launchd's soma and a plain `node src/main.ts` read the same one. */
export function configPath(env: Env, home: string): string {
	return env.SOMA_CONFIG?.trim() || join(home, ".config/soma/config.json");
}

// Tailscale gives each node an address in 100.64.0.0/10 and one in fd7a:115c:a1e0::/48:
// https://tailscale.com/kb/1015/100.x-addresses and https://tailscale.com/kb/1033/ip-and-dns-addresses
const tailnet = new BlockList();
tailnet.addSubnet("100.64.0.0", 10, "ipv4");
tailnet.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/** Whether `host` is a single tailnet address: the page has no login, so it is never served anywhere else. */
export function isTailnetAddress(host: string): boolean {
	const family = isIP(host);
	return family !== 0 && tailnet.check(host, family === 4 ? "ipv4" : "ipv6");
}

/** `value` parsed, else a ConfigError naming the config path and each field at fault, under `prefix`. */
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, path: string, prefix: readonly string[] = []): T {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	const issues = parsed.error.issues.map((issue) => {
		const at = [...prefix, ...issue.path];
		const keys = issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...at, key].join(".")) : [];
		return `${keys.join(", ") || at.join(".") || "(top level)"}: ${issue.message}`;
	});
	throw new ConfigError(`${path}: ${issues.join("; ")}`);
}

/** A missing file is no file; a file soma cannot use throws rather than run with part of it. */
export function readConfigFile(path: string, warn: (message: string) => void = console.warn): FileConfig | undefined {
	if (!existsSync(path)) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`${path}: not valid JSON: ${(error as Error).message}`);
	}
	const file = parseOrThrow(FileConfig, json, path);
	if ((file.anthropic?.apiKey || file.exa?.apiKey || file.telegram?.botToken) && statSync(path).mode & 0o044) {
		warn(`[soma] ${path} holds a key or token and is readable by group or others; run chmod 600 ${path}`);
	}
	return file;
}

/**
 * Each value comes from its environment variable, else the config file, else the default. `path` names the config file
 * in an error about a value that is missing rather than malformed.
 */
export function resolveConfig(file: FileConfig | undefined, env: Env, home: string, path = "config"): Config {
	const fromEnv = (name: string) => env[name]?.trim() || undefined;
	const parseEnv = <T>(name: string, parse: (value: string) => T | undefined, expected: string): T | undefined => {
		const value = fromEnv(name);
		if (value === undefined) return undefined;
		const parsed = parse(value);
		if (parsed === undefined) throw new ConfigError(`${name} must be ${expected}, got "${value}"`);
		return parsed;
	};

	const hangarCap =
		parseEnv("SOMA_HANGAR_CAP", (v) => (/^[1-9][0-9]*$/.test(v) ? Number(v) : undefined), "a positive integer") ??
		file?.hangarCap;
	const programStatus =
		parseEnv("SOMA_PROGRAM_STATUS", (v) => ({ 1: true, 0: false })[v], "1 or 0") ?? file?.programStatus;
	const reflection = parseEnv("SOMA_REFLECTION", (v) => ({ 1: true, 0: false })[v], "1 or 0") ?? file?.reflection;
	const anthropicApiKey = file?.anthropic?.apiKey;
	const exaApiKey = fromEnv("EXA_API_KEY") ?? file?.exa?.apiKey;
	const token = fromEnv("TELEGRAM_BOT_TOKEN") ?? file?.telegram?.botToken;
	const chatId =
		parseEnv(
			"TELEGRAM_CHAT_ID",
			(v) => (/^-?[0-9]+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : undefined),
			"an integer",
		) ?? file?.telegram?.chatId;
	const apiBase = fromEnv("TELEGRAM_API_BASE") ?? file?.telegram?.apiBase ?? "https://api.telegram.org";
	const webHost = fromEnv("SOMA_WEB_HOST") ?? file?.web?.host;
	const webPort =
		parseEnv(
			"SOMA_WEB_PORT",
			(v) => (/^[1-9][0-9]*$/.test(v) && Number(v) <= 65535 ? Number(v) : undefined),
			"a port from 1 to 65535",
		) ?? file?.web?.port;
	if (webHost !== undefined && !isTailnetAddress(webHost)) {
		throw new ConfigError(
			`${path}: web.host: Expected one tailnet IP address (100.64.0.0/10 or fd7a:115c:a1e0::/48, see tailscale ip), got "${webHost}"`,
		);
	}
	const agentAdapter =
		parseEnv(
			"SOMA_AGENT_ADAPTER",
			(v) => AGENT_ADAPTERS.find((adapter) => adapter === v),
			AGENT_ADAPTERS.map((adapter) => `"${adapter}"`).join(" or "),
		) ??
		file?.agentAdapter ??
		"herdr";
	return {
		agentAdapter,
		// The hangar session, never $HERDR_SOCKET_PATH: that names whichever session soma itself runs in.
		herdrSocket:
			fromEnv("SOMA_HERDR_SOCKET") ?? file?.herdrSocket ?? join(home, ".config/herdr/sessions/fleet/herdr.sock"),
		// Outside the repo: each server's entry names where its own OAuth credentials live.
		mcpConfig: fromEnv("SOMA_MCP_CONFIG") ?? file?.mcpConfig ?? join(home, ".config/soma/mcp.json"),
		db: fromEnv("SOMA_DB") ?? file?.db ?? "soma.sqlite",
		model: fromEnv("SOMA_MODEL") ?? file?.model ?? "claude-opus-5-5",
		language:
			parseEnv("SOMA_LANGUAGE", canonicalLanguage, "a BCP 47 language tag") ??
			(file?.language === undefined ? undefined : canonicalLanguage(file.language)) ??
			"en",
		// Unset, the checkout this code runs from; a release directory is not a git repo, so prod sets it.
		repo: fromEnv("SOMA_REPO") ?? file?.repo ?? dirname(dirname(fileURLToPath(import.meta.url))),
		reflection: reflection ?? true,
		...(agentAdapter === "rex" && { rex: resolveRex(file, fromEnv, home, path) }),
		...(hangarCap !== undefined && { hangarCap }),
		...(programStatus !== undefined && { programStatus }),
		...(anthropicApiKey !== undefined && { anthropicApiKey }),
		...(exaApiKey !== undefined && { exaApiKey }),
		...(token !== undefined && chatId !== undefined && { telegram: { token, chatId, apiBase } }),
		...(webHost !== undefined && webPort !== undefined && { web: { host: webHost, port: webPort } }),
	};
}

/** Read only when rex is selected, so a herdr setup never trips over them. */
function resolveRex(
	file: FileConfig | undefined,
	fromEnv: (name: string) => string | undefined,
	home: string,
	path: string,
): RexConfig {
	const rex = file?.rex === undefined ? undefined : parseOrThrow(RexFileConfig, file.rex, path, ["rex"]);
	const sessionId = fromEnv("SOMA_REX_SESSION_ID") ?? rex?.sessionId;
	if (sessionId === undefined) {
		throw new ConfigError(
			`${path}: rex.sessionId: Required when agentAdapter is "rex" (or set SOMA_REX_SESSION_ID): the hangar session's id`,
		);
	}
	if (!/^session:\S+$/.test(sessionId)) {
		throw new ConfigError(
			`${path}: rex.sessionId: Expected a rex session id such as "session:<uuid>", got "${sessionId}"`,
		);
	}
	return {
		sessionId,
		socket: fromEnv("SOMA_REX_SOCKET") ?? rex?.socket ?? defaultRexSocket(home),
	};
}

export function loadConfig(path: string, env: Env, home: string, warn?: (message: string) => void): Config {
	return resolveConfig(readConfigFile(path, warn), env, home, path);
}

/**
 * pi-ai's own environment lookup, with the config file's key behind ANTHROPIC_API_KEY. The provider tries
 * ANTHROPIC_AUTH_TOKEN and ANTHROPIC_OAUTH_TOKEN first, so any ANTHROPIC_* variable still beats the file. A stored
 * credential would not: pi-ai consults the environment only when its credential store holds nothing.
 */
export function anthropicAuthContext(
	apiKey: string | undefined,
	base: AuthContext = defaultProviderAuthContext(),
): AuthContext {
	return {
		env: async (name) => (await base.env(name)) ?? (name === "ANTHROPIC_API_KEY" ? apiKey : undefined),
		fileExists: (path) => base.fileExists(path),
	};
}
