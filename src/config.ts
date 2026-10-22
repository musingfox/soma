import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AuthContext, defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { TelegramConfig } from "./adapters/telegram/index.ts";

/** The canonical form of a BCP 47 language tag, or undefined when it is not one. */
function canonicalLanguage(tag: string): string | undefined {
	try {
		return Intl.getCanonicalLocales(tag)[0];
	} catch {
		return undefined;
	}
}

const FileConfig = z
	.object({
		herdrSocket: z.string().min(1),
		mcpConfig: z.string().min(1),
		db: z.string().min(1),
		model: z.string().min(1),
		language: z.string().refine((tag) => canonicalLanguage(tag) !== undefined, "Expected a BCP 47 language tag"),
		hangarCap: z.number().int().positive(),
		programStatus: z.boolean(),
		anthropic: z
			.object({ apiKey: z.string().min(1) })
			.partial()
			.strict(),
		telegram: z
			.object({ botToken: z.string().min(1), chatId: z.number().int().safe(), apiBase: z.string().url() })
			.partial()
			.strict(),
	})
	.partial()
	.strict();
export type FileConfig = z.infer<typeof FileConfig>;

export interface Config {
	readonly herdrSocket: string;
	readonly mcpConfig: string;
	readonly db: string;
	readonly model: string;
	/** The BCP 47 tag of the language soma answers the human in. */
	readonly language: string;
	/** Unset: performance cores minus two, see hangar-cap.ts. */
	readonly hangarCap?: number;
	/** Unset: ask the terminal whether it supports OSC 7501. */
	readonly programStatus?: boolean;
	readonly anthropicApiKey?: string;
	/** Set only when both a bot token and a chat id are. */
	readonly telegram?: TelegramConfig;
}

type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {}

/** A missing file is no file; a file soma cannot use throws rather than run with part of it. */
export function readConfigFile(path: string, warn: (message: string) => void = console.warn): FileConfig | undefined {
	if (!existsSync(path)) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`${path}: not valid JSON: ${(error as Error).message}`);
	}
	const parsed = FileConfig.safeParse(json);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => {
			const keys = issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...issue.path, key].join(".")) : [];
			return `${keys.join(", ") || issue.path.join(".") || "(top level)"}: ${issue.message}`;
		});
		throw new ConfigError(`${path}: ${issues.join("; ")}`);
	}
	const file = parsed.data;
	if ((file.anthropic?.apiKey || file.telegram?.botToken) && statSync(path).mode & 0o044) {
		warn(`[soma] ${path} holds a key or token and is readable by group or others; run chmod 600 ${path}`);
	}
	return file;
}

/** Each value comes from its environment variable, else the config file, else the default. */
export function resolveConfig(file: FileConfig | undefined, env: Env, home: string): Config {
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
	const anthropicApiKey = file?.anthropic?.apiKey;
	const token = fromEnv("TELEGRAM_BOT_TOKEN") ?? file?.telegram?.botToken;
	const chatId =
		parseEnv(
			"TELEGRAM_CHAT_ID",
			(v) => (/^-?[0-9]+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : undefined),
			"an integer",
		) ?? file?.telegram?.chatId;
	const apiBase = fromEnv("TELEGRAM_API_BASE") ?? file?.telegram?.apiBase ?? "https://api.telegram.org";
	return {
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
		...(hangarCap !== undefined && { hangarCap }),
		...(programStatus !== undefined && { programStatus }),
		...(anthropicApiKey !== undefined && { anthropicApiKey }),
		...(token !== undefined && chatId !== undefined && { telegram: { token, chatId, apiBase } }),
	};
}

export function loadConfig(path: string, env: Env, home: string, warn?: (message: string) => void): Config {
	return resolveConfig(readConfigFile(path, warn), env, home);
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
