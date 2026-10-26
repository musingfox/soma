import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AuthContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
	anthropicAuthContext,
	ConfigError,
	configPath,
	type FileConfig,
	loadConfig,
	resolveConfig,
} from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "soma-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
function write(content: string, mode = 0o600): string {
	const path = join(dir, `config-${files++}.json`);
	writeFileSync(path, content);
	chmodSync(path, mode);
	return path;
}

const HOME = "/home/me";
// Both halves of the Telegram pair are set by the other source, so each row isolates one field.
const TELEGRAM_FILE: FileConfig = { telegram: { botToken: "file-token", chatId: 7 } };
const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: "env-token", TELEGRAM_CHAT_ID: "8" };

// Each row: the variable and its value, the file that sets the same field, and the value from env, file, default.
const fields = [
	{
		name: "herdrSocket",
		env: ["SOMA_HERDR_SOCKET", "/env.sock"],
		file: { herdrSocket: "/file.sock" },
		read: (c) => c.herdrSocket,
		values: ["/env.sock", "/file.sock", "/home/me/.config/herdr/sessions/fleet/herdr.sock"],
	},
	{
		name: "mcpConfig",
		env: ["SOMA_MCP_CONFIG", "/env.json"],
		file: { mcpConfig: "/file.json" },
		read: (c) => c.mcpConfig,
		values: ["/env.json", "/file.json", "/home/me/.config/soma/mcp.json"],
	},
	{
		name: "db",
		env: ["SOMA_DB", "env.sqlite"],
		file: { db: "file.sqlite" },
		read: (c) => c.db,
		values: ["env.sqlite", "file.sqlite", "soma.sqlite"],
	},
	{
		name: "model",
		env: ["SOMA_MODEL", "env-model"],
		file: { model: "file-model" },
		read: (c) => c.model,
		values: ["env-model", "file-model", "claude-opus-5-5"],
	},
	{
		name: "language",
		env: ["SOMA_LANGUAGE", "ja"],
		file: { language: "zh-hant-tw" },
		read: (c) => c.language,
		values: ["ja", "zh-Hant-TW", "en"],
	},
	{
		name: "hangarCap",
		env: ["SOMA_HANGAR_CAP", "3"],
		file: { hangarCap: 5 },
		read: (c) => c.hangarCap,
		values: [3, 5, undefined],
	},
	{
		name: "programStatus",
		env: ["SOMA_PROGRAM_STATUS", "0"],
		file: { programStatus: true },
		read: (c) => c.programStatus,
		values: [false, true, undefined],
	},
	{
		name: "repo",
		env: ["SOMA_REPO", "/env/soma"],
		file: { repo: "/file/soma" },
		read: (c) => c.repo,
		values: ["/env/soma", "/file/soma", resolve(import.meta.dirname, "..")],
	},
	{
		name: "reflection",
		env: ["SOMA_REFLECTION", "1"],
		file: { reflection: false },
		read: (c) => c.reflection,
		values: [true, false, true],
	},
	{
		name: "telegram.botToken",
		env: ["TELEGRAM_BOT_TOKEN", "env-token"],
		file: { telegram: { botToken: "file-token" } },
		base: { env: { TELEGRAM_CHAT_ID: "8" } },
		read: (c) => c.telegram?.token,
		values: ["env-token", "file-token", undefined],
	},
	{
		name: "telegram.chatId",
		env: ["TELEGRAM_CHAT_ID", "-100"],
		file: { telegram: { chatId: 9 } },
		base: { env: { TELEGRAM_BOT_TOKEN: "t" } },
		read: (c) => c.telegram?.chatId,
		values: [-100, 9, undefined],
	},
	{
		name: "telegram.apiBase",
		env: ["TELEGRAM_API_BASE", "http://env"],
		file: { telegram: { ...TELEGRAM_FILE.telegram, apiBase: "http://file" } },
		base: { env: TELEGRAM_ENV },
		read: (c) => c.telegram?.apiBase,
		values: ["http://env", "http://file", "https://api.telegram.org"],
	},
] satisfies {
	name: string;
	env: [string, string];
	file: FileConfig;
	base?: { env: Record<string, string> };
	read: (config: ReturnType<typeof resolveConfig>) => unknown;
	values: [unknown, unknown, unknown];
}[];

describe.each(fields)("$name", ({ env: [name, value], file, base, read, values: [fromEnv, fromFile, byDefault] }) => {
	const baseEnv = base?.env ?? {};
	test("the environment variable beats the config file", () => {
		expect(read(resolveConfig(file, { ...baseEnv, [name]: value }, HOME))).toEqual(fromEnv);
	});
	test("the config file beats the default", () => {
		expect(read(resolveConfig(file, baseEnv, HOME))).toEqual(fromFile);
	});
	test("the default applies when neither sets it", () => {
		expect(read(resolveConfig(undefined, baseEnv, HOME))).toEqual(byDefault);
	});
	test("a blank environment variable counts as unset", () => {
		expect(read(resolveConfig(file, { ...baseEnv, [name]: " " }, HOME))).toEqual(fromFile);
	});
});

describe("anthropic.apiKey", () => {
	const fakeEnv = (values: Record<string, string>): AuthContext => ({
		env: async (name) => values[name],
		fileExists: async () => false,
	});
	async function auth(apiKey: string | undefined, env: Record<string, string>) {
		const models = createModels({ authContext: anthropicAuthContext(apiKey, fakeEnv(env)) });
		models.setProvider(anthropicProvider());
		return models.getAuth("anthropic");
	}

	test("the config file carries the key", () => {
		expect(resolveConfig({ anthropic: { apiKey: "file-key" } }, {}, HOME).anthropicApiKey).toBe("file-key");
		expect(resolveConfig(undefined, {}, HOME).anthropicApiKey).toBeUndefined();
	});
	test("ANTHROPIC_API_KEY beats the config file", async () => {
		expect((await auth("file-key", { ANTHROPIC_API_KEY: "env-key" }))?.auth).toEqual({ apiKey: "env-key" });
	});
	test("ANTHROPIC_AUTH_TOKEN beats the config file too", async () => {
		expect((await auth("file-key", { ANTHROPIC_AUTH_TOKEN: "tok" }))?.auth).toEqual({
			headers: { Authorization: "Bearer tok" },
		});
	});
	test("the config file's key configures the provider", async () => {
		expect((await auth("file-key", {}))?.auth).toEqual({ apiKey: "file-key" });
	});
	test("neither leaves the provider unconfigured", async () => {
		expect(await auth(undefined, {})).toBeUndefined();
	});
});

describe("Telegram", () => {
	test("is on only with both a token and a chat id, from either source", () => {
		expect(resolveConfig(undefined, { TELEGRAM_BOT_TOKEN: "t" }, HOME).telegram).toBeUndefined();
		expect(resolveConfig({ telegram: { chatId: 1 } }, {}, HOME).telegram).toBeUndefined();
		expect(resolveConfig({ telegram: { chatId: 1 } }, { TELEGRAM_BOT_TOKEN: "t" }, HOME).telegram).toEqual({
			token: "t",
			chatId: 1,
			apiBase: "https://api.telegram.org",
		});
	});
});

describe("invalid environment variables", () => {
	test.each([
		["SOMA_HANGAR_CAP", "0"],
		["SOMA_HANGAR_CAP", "four"],
		["SOMA_PROGRAM_STATUS", "yes"],
		["SOMA_REFLECTION", "off"],
		["TELEGRAM_CHAT_ID", "me"],
		["SOMA_LANGUAGE", "繁體中文"],
	])("%s=%s throws naming the variable", (name, value) => {
		expect(() => resolveConfig(undefined, { [name]: value }, HOME)).toThrow(new ConfigError(`${name} must be`).message);
	});
});

describe("the config file", () => {
	test("missing means no file", () => {
		expect(loadConfig(join(dir, "absent.json"), {}, HOME).db).toBe("soma.sqlite");
	});
	test("broken JSON throws with the path", () => {
		const path = write("{ db: ");
		expect(() => loadConfig(path, {}, HOME)).toThrow(ConfigError);
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: not valid JSON`);
	});
	test("a field of the wrong type throws with the path and the field", () => {
		const path = write(JSON.stringify({ hangarCap: "4", telegram: { chatId: "me" } }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(path);
		expect(() => loadConfig(path, {}, HOME)).toThrow(/hangarCap: Expected number.*telegram\.chatId: Expected number/);
	});
	test("a language that is not a BCP 47 tag throws with the field", () => {
		const path = write(JSON.stringify({ language: "繁體中文" }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: language: Expected a BCP 47 language tag`);
	});
	test("an unknown field throws with its name", () => {
		const path = write(JSON.stringify({ telegram: { token: "t" } }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: telegram.token: Unrecognized key`);
	});
});

describe("the permission warning", () => {
	test.each([
		["a key, readable by others", { anthropic: { apiKey: "k" } }, 0o604, true],
		["a token, readable by the group", { telegram: { botToken: "t" } }, 0o640, true],
		["a key, owner only", { anthropic: { apiKey: "k" } }, 0o600, false],
		["no secret, readable by all", { db: "x.sqlite" }, 0o644, false],
	])("%s", (_, file, mode, warned) => {
		const warn = vi.fn();
		const path = write(JSON.stringify(file), mode);
		loadConfig(path, {}, HOME, warn);
		if (warned) expect(warn).toHaveBeenCalledWith(expect.stringContaining(path));
		else expect(warn).not.toHaveBeenCalled();
	});
});

describe("SOMA_REFLECTION", () => {
	test("SOMA_REFLECTION=0 turns it off over a config file that turns it on", () => {
		expect(resolveConfig({ reflection: true }, { SOMA_REFLECTION: "0" }, HOME).reflection).toBe(false);
	});
});

describe("configPath", () => {
	test("SOMA_CONFIG names the file", () => {
		expect(configPath({ SOMA_CONFIG: "/srv/soma/dev.json" }, "/home/me")).toBe("/srv/soma/dev.json");
	});
	test("unset, it is the one under ~/.config/soma", () => {
		expect(configPath({}, "/home/me")).toBe("/home/me/.config/soma/config.json");
	});
	test("a blank SOMA_CONFIG counts as unset", () => {
		expect(configPath({ SOMA_CONFIG: "  " }, "/home/me")).toBe("/home/me/.config/soma/config.json");
	});
});
