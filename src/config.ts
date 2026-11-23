import { existsSync, readFileSync, statSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AuthContext, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { z } from "zod";
import { defaultRexSocket } from "./adapters/rex/client.ts";
import type { TelegramConfig } from "./adapters/telegram/index.ts";
import { SERVE_HOST, type WebConfig } from "./adapters/web/index.ts";
import { POLICIES, type PolicyTable, PRESETS } from "./core/domain/push.ts";
import { MESSAGE_CLASSES } from "./ports/human.ts";

/** The canonical form of a BCP 47 language tag, or undefined when it is not one. */
function canonicalLanguage(tag: string): string | undefined {
	try {
		return Intl.getCanonicalLocales(tag)[0];
	} catch {
		return undefined;
	}
}

/** The agent-side adapters soma can dispatch through; the config picks one. */
export const AGENT_ADAPTERS = ["herdr", "rex", "tty", "acp"] as const;
export type AgentAdapter = (typeof AGENT_ADAPTERS)[number];

/** The interfaces whose push policy the config sets. */
export const INTERFACES = ["telegram", "terminal", "web"] as const;
export type Interface = (typeof INTERFACES)[number];

const PUSH_VALUE = `a preset (${Object.keys(PRESETS)
	.map((name) => `"${name}"`)
	.join(", ")}) or a table setting each of ${MESSAGE_CLASSES.join(", ")}`;
const POLICY_VALUE = POLICIES.map((policy) => `"${policy}"`).join(", ");

const PolicyFile = z
	.string({ required_error: `Required: a table sets ${MESSAGE_CLASSES.join(", ")}` })
	.superRefine((value, ctx) => {
		if ((POLICIES as readonly string[]).includes(value)) return;
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown policy "${value}"; expected ${POLICY_VALUE}` });
	});
// A table sets every class: a class left out would need a default, and the config is where the human says it.
const PolicyTableFile = z.object({ action: PolicyFile, outcome: PolicyFile, ambient: PolicyFile }).strict();

const PushFileConfig = z
	.object({ telegram: z.unknown(), terminal: z.unknown(), web: z.unknown(), summary: z.unknown() })
	.partial()
	.strict();

// Minutes, not whole ones only, so a dev run can cut the wait short.
const SummaryFileConfig = z.object({ idleMinutes: z.number().positive() }).partial().strict();

/** How long the human types nowhere before what interfaces hold is summarized, unless the config says otherwise. */
export const SUMMARY_IDLE_MINUTES = 30;

/** The root conversation's size in tokens past which it is compacted, unless the config says otherwise (2026-11-18). */
export const COMPACT_AT = 100_000;

/** The dream's model and period unless `dream` says otherwise; see "Dream" in ARCHITECTURE.md. */
export const DREAM_MODEL = "claude-opus-5-5";
export const DREAM_PERIOD_DAYS = 7;

const DreamFileConfig = z
	.object({ model: z.string().min(1), periodDays: z.number().int().positive(), log: z.string().min(1) })
	.partial()
	.strict();

/** The periodic review of soma's own records; set only when `dream` is an object. */
export interface DreamConfig {
	readonly model: string;
	readonly periodDays: number;
	/** soma's log file, whose lines in the window the dream profiles; unset, no log is read. */
	readonly log?: string;
}

/**
 * The hangar is a rex session found by its id, never by its label, which rex does not keep unique. When rex says the
 * session soma would use does not exist, soma makes a new one labelled `label`, `soma-hangar` when unset, uses it from
 * then on, and remembers it next to the db, never in this file, which soma does not write: a restart uses the session
 * made in place of `sessionId` while it exists, and makes one more once that one is gone too.
 */
export interface RexConfig {
	readonly sessionId: string;
	readonly socket: string;
	readonly label?: string;
}

// Checked only when rex or acp is selected, so a herdr setup never trips over a rex block it does not use. rex takes a
// session label of up to 128 characters.
const RexFileConfig = z
	.object({ sessionId: z.string().min(1), socket: z.string().min(1), label: z.string().min(1).max(128) })
	.partial()
	.strict();

const FileConfig = z
	.object({
		herdrSocket: z.string().min(1),
		mcpConfig: z.string().min(1),
		db: z.string().min(1),
		deferSocket: z.string().min(1),
		handoffDir: z.string().min(1),
		model: z.string().min(1),
		language: z.string().refine((tag) => canonicalLanguage(tag) !== undefined, "Expected a BCP 47 language tag"),
		hangarCap: z.number().int().positive(),
		compactAt: z.number().int().positive(),
		programStatus: z.boolean(),
		repo: z.string().min(1),
		reposDir: z.string().refine(isAbsolute, "Expected an absolute path"),
		reflection: z.boolean(),
		dream: z.unknown(),
		agentAdapter: z.enum(AGENT_ADAPTERS),
		rex: z.unknown(),
		push: z.unknown(),
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
			.object({
				host: z.string().min(1),
				port: z.number().int().min(1).max(65535),
				origin: z.string().min(1),
				login: z.string().min(1),
			})
			.partial()
			.strict(),
		vault: z
			.object({ name: z.string().min(1), deny: z.array(z.string().min(1)) })
			.partial()
			.strict(),
		skillsDir: z.string().min(1),
	})
	.partial()
	.strict();
export type FileConfig = z.infer<typeof FileConfig>;

export interface Config {
	readonly agentAdapter: AgentAdapter;
	readonly herdrSocket: string;
	/**
	 * Set when `agentAdapter` is rex, and when it is acp and a hangar session is named: then jobs run over ACP and one
	 * the human asks to see is handed over to that hangar.
	 */
	readonly rex?: RexConfig;
	readonly mcpConfig: string;
	readonly db: string;
	/** The unix socket `soma defer` reaches soma on; absolute, since agents run it from their own directories. */
	readonly deferSocket: string;
	/** The drop directory a Claude Code session hands soma timed work through; absolute, as the defer socket is. */
	readonly handoffDir: string;
	readonly model: string;
	/** The BCP 47 tag of the language soma answers the human in. */
	readonly language: string;
	/** Unset: performance cores minus two, see hangar-cap.ts. */
	readonly hangarCap?: number;
	/** The root conversation's size in tokens past which it is compacted; see "Compacting the root conversation". */
	readonly compactAt: number;
	/** Unset: ask the terminal whether it supports OSC 7501. */
	readonly programStatus?: boolean;
	/** soma's own repository: the reflection's code-change cards go to the vault project its `.obsidian.yaml` names. */
	readonly repo: string;
	/**
	 * The folder whose direct children are the git repos `soma dispatch` may start a job in; unset, it starts none.
	 * Absolute, since the CLI and soma resolve it from different directories.
	 */
	readonly reposDir?: string;
	readonly reflection: boolean;
	/** Off unless the file's `dream` is an object; file only, so it costs nothing unless written there. */
	readonly dream?: DreamConfig;
	readonly anthropicApiKey?: string;
	readonly exaApiKey?: string;
	/** Set only when both a bot token and a chat id are. */
	readonly telegram?: TelegramConfig;
	/** Set only when a port is and either a tailnet host or, in serve mode, an origin and a login are. */
	readonly web?: WebConfig;
	/** The Obsidian vault soma may read, by the name the obsidian CLI knows; set only when a name is. */
	readonly vault?: VaultConfig;
	/** Where soma's skills are, one directory with a SKILL.md each (card soma-skills). */
	readonly skillsDir: string;
	/** Each interface's push policy; one the file leaves unset is `instant`, which is how soma pushed before. */
	readonly push: Readonly<Record<Interface, PolicyTable>>;
	/** `push.summary.idleMinutes` in ms: how long the human types nowhere before what is held is summarized. */
	readonly summaryIdleMs: number;
}

export interface VaultConfig {
	readonly name: string;
	/** Folders soma neither reads nor writes. */
	readonly deny: readonly string[];
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

/**
 * The canonical origin of `value` when it is `https://` with a host and no path, else undefined. The port is the
 * default or explicit; the canonical form drops a default one, as a browser's Origin and Host do.
 */
export function serveOrigin(value: string): string | undefined {
	const url = URL.canParse(value) ? new URL(value) : undefined;
	if (url === undefined || url.protocol !== "https:" || url.hostname === "") return undefined;
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
	// `new URL` adds the slash of an empty path, so only the origin itself, with or without the default port, is no path.
	return value.toLowerCase().replace(/:443$/, "") === url.origin ? url.origin : undefined;
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
	const compactAt =
		parseEnv("SOMA_COMPACT_AT", (v) => (/^[1-9][0-9]*$/.test(v) ? Number(v) : undefined), "a positive integer") ??
		file?.compactAt ??
		COMPACT_AT;
	const programStatus =
		parseEnv("SOMA_PROGRAM_STATUS", (v) => ({ 1: true, 0: false })[v], "1 or 0") ?? file?.programStatus;
	const reposDir =
		parseEnv("SOMA_REPOS_DIR", (v) => (isAbsolute(v) ? v : undefined), "an absolute path") ?? file?.reposDir;
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
	const webOrigin = fromEnv("SOMA_WEB_ORIGIN") ?? file?.web?.origin;
	const webLogin = fromEnv("SOMA_WEB_LOGIN") ?? file?.web?.login;
	const web = resolveWeb(webHost, webPort, webOrigin, webLogin, path);
	const agentAdapter =
		parseEnv(
			"SOMA_AGENT_ADAPTER",
			(v) => AGENT_ADAPTERS.find((adapter) => adapter === v),
			AGENT_ADAPTERS.map((adapter) => `"${adapter}"`).join(" or "),
		) ??
		file?.agentAdapter ??
		"herdr";
	const db = fromEnv("SOMA_DB") ?? file?.db ?? "soma.sqlite";
	const dream = resolveDream(file?.dream, path);
	return {
		agentAdapter,
		// The hangar session, never $HERDR_SOCKET_PATH: that names whichever session soma itself runs in.
		herdrSocket:
			fromEnv("SOMA_HERDR_SOCKET") ?? file?.herdrSocket ?? join(home, ".config/herdr/sessions/fleet/herdr.sock"),
		// Outside the repo: each server's entry names where its own OAuth credentials live.
		mcpConfig: fromEnv("SOMA_MCP_CONFIG") ?? file?.mcpConfig ?? join(home, ".config/soma/mcp.json"),
		db,
		// Next to the db by default: one soma per db (acquireDbLock), so prod and a dev instance never share a socket.
		deferSocket: resolve(fromEnv("SOMA_DEFER_SOCKET") ?? file?.deferSocket ?? `${db}.defer.sock`),
		// Next to the db for the same reason: prod and a dev instance never take each other's requests.
		handoffDir: resolve(fromEnv("SOMA_HANDOFF_DIR") ?? file?.handoffDir ?? `${db}.handoff`),
		model: fromEnv("SOMA_MODEL") ?? file?.model ?? "claude-opus-5-5",
		language:
			parseEnv("SOMA_LANGUAGE", canonicalLanguage, "a BCP 47 language tag") ??
			(file?.language === undefined ? undefined : canonicalLanguage(file.language)) ??
			"en",
		// Unset, the checkout this code runs from; a release directory is not a git repo, so prod sets it.
		repo: fromEnv("SOMA_REPO") ?? file?.repo ?? dirname(dirname(fileURLToPath(import.meta.url))),
		reflection: reflection ?? true,
		compactAt,
		...((agentAdapter === "rex" || (agentAdapter === "acp" && namesHangar(file, fromEnv, path))) && {
			rex: resolveRex(file, fromEnv, home, path),
		}),
		...(reposDir !== undefined && { reposDir }),
		...(dream !== undefined && { dream }),
		...(hangarCap !== undefined && { hangarCap }),
		...(programStatus !== undefined && { programStatus }),
		...(anthropicApiKey !== undefined && { anthropicApiKey }),
		...(exaApiKey !== undefined && { exaApiKey }),
		...(token !== undefined && chatId !== undefined && { telegram: { token, chatId, apiBase } }),
		...(web !== undefined && { web }),
		...(file?.vault?.name !== undefined && { vault: { name: file.vault.name, deny: file.vault.deny ?? [] } }),
		skillsDir: resolve(fromEnv("SOMA_SKILLS_DIR") ?? file?.skillsDir ?? join(home, ".config/soma/skills")),
		push: resolvePush(file?.push, path),
		summaryIdleMs: resolveSummaryIdle(file?.push, path) * 60_000,
	};
}

/** The file only: a policy is set once per interface, with no environment variable and no switching by time. */
function resolvePush(push: unknown, path: string): Record<Interface, PolicyTable> {
	const set = push === undefined ? {} : parseOrThrow(PushFileConfig, push, path, ["push"]);
	const policyOf = (name: Interface): PolicyTable => {
		const value = set[name];
		if (value === undefined) return PRESETS.instant;
		if (typeof value === "string") {
			if (value in PRESETS) return PRESETS[value as keyof typeof PRESETS];
			throw new ConfigError(`${path}: push.${name}: Unknown preset "${value}"; expected ${PUSH_VALUE}`);
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new ConfigError(`${path}: push.${name}: Expected ${PUSH_VALUE}`);
		}
		return parseOrThrow(PolicyTableFile, value, path, ["push", name]) as PolicyTable;
	};
	return { telegram: policyOf("telegram"), terminal: policyOf("terminal"), web: policyOf("web") };
}

/** The file only: absent or `false` is off; an object turns it on, each field it leaves out at its default. */
function resolveDream(dream: unknown, path: string): DreamConfig | undefined {
	if (dream === undefined || dream === false) return undefined;
	if (typeof dream !== "object" || dream === null || Array.isArray(dream)) {
		throw new ConfigError(
			`${path}: dream: Expected false or an object such as { "model": "${DREAM_MODEL}", "periodDays": ${DREAM_PERIOD_DAYS} }`,
		);
	}
	const set = parseOrThrow(DreamFileConfig, dream, path, ["dream"]);
	return {
		model: set.model ?? DREAM_MODEL,
		periodDays: set.periodDays ?? DREAM_PERIOD_DAYS,
		...(set.log !== undefined && { log: resolve(set.log) }),
	};
}

function resolveSummaryIdle(push: unknown, path: string): number {
	const { summary } = push === undefined ? {} : parseOrThrow(PushFileConfig, push, path, ["push"]);
	if (summary === undefined) return SUMMARY_IDLE_MINUTES;
	return parseOrThrow(SummaryFileConfig, summary, path, ["push", "summary"]).idleMinutes ?? SUMMARY_IDLE_MINUTES;
}

/**
 * The web page's settings: the tailnet-IP mode (`host`) or serve mode (`origin` and `login`, listening on loopback),
 * never both and never half of serve mode. Off, as before, without a port.
 */
function resolveWeb(
	host: string | undefined,
	port: number | undefined,
	origin: string | undefined,
	login: string | undefined,
	path: string,
): WebConfig | undefined {
	if (origin === undefined && login === undefined) {
		return host !== undefined && port !== undefined ? { host, port } : undefined;
	}
	if (host !== undefined) {
		throw new ConfigError(
			`${path}: web.host: Not allowed with ${origin === undefined ? "web.login" : "web.origin"}: serve mode listens on 127.0.0.1, the tailnet-IP mode on its own address`,
		);
	}
	if (origin === undefined) throw new ConfigError(`${path}: web.origin: Required with web.login`);
	if (login === undefined) throw new ConfigError(`${path}: web.login: Required with web.origin`);
	const canonical = serveOrigin(origin);
	if (canonical === undefined) {
		throw new ConfigError(
			`${path}: web.origin: Expected an https:// origin with a host and no path, such as https://my-mac.tail1234.ts.net:8445, got "${origin}"`,
		);
	}
	return port === undefined ? undefined : { host: SERVE_HOST, port, serve: { origin: canonical, login } };
}

/** Whether a hangar session is named: without one, acp runs alone and hands nothing over. */
function namesHangar(
	file: FileConfig | undefined,
	fromEnv: (name: string) => string | undefined,
	path: string,
): boolean {
	const rex = file?.rex === undefined ? undefined : parseOrThrow(RexFileConfig, file.rex, path, ["rex"]);
	return (fromEnv("SOMA_REX_SESSION_ID") ?? rex?.sessionId) !== undefined;
}

/** Read only when rex is selected, or named beside acp, so a herdr setup never trips over them. */
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
		...(rex?.label !== undefined && { label: rex.label }),
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
