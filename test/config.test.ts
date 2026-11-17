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
		name: "deferSocket",
		env: ["SOMA_DEFER_SOCKET", "/env.sock"],
		file: { deferSocket: "/file.sock" },
		base: { env: { SOMA_DB: "/data/soma.sqlite" } },
		read: (c) => c.deferSocket,
		values: ["/env.sock", "/file.sock", "/data/soma.sqlite.defer.sock"],
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
		name: "compactAt",
		env: ["SOMA_COMPACT_AT", "20000"],
		file: { compactAt: 50000 },
		read: (c) => c.compactAt,
		values: [20000, 50000, 100000],
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
	{
		name: "web.host",
		env: ["SOMA_WEB_HOST", "100.101.102.103"],
		file: { web: { host: "fd7a:115c:a1e0::1" } },
		base: { env: { SOMA_WEB_PORT: "8790" } },
		read: (c) => c.web?.host,
		values: ["100.101.102.103", "fd7a:115c:a1e0::1", undefined],
	},
	{
		name: "web.port",
		env: ["SOMA_WEB_PORT", "8791"],
		file: { web: { port: 8790 } },
		base: { env: { SOMA_WEB_HOST: "100.101.102.103" } },
		read: (c) => c.web?.port,
		values: [8791, 8790, undefined],
	},
	{
		name: "exa.apiKey",
		env: ["EXA_API_KEY", "env-key"],
		file: { exa: { apiKey: "file-key" } },
		read: (c) => c.exaApiKey,
		values: ["env-key", "file-key", undefined],
	},
	{
		name: "agentAdapter",
		env: ["SOMA_AGENT_ADAPTER", "herdr"],
		file: { agentAdapter: "rex" },
		base: { env: { SOMA_REX_SESSION_ID: "session:hangar" } },
		read: (c) => c.agentAdapter,
		values: ["herdr", "rex", "herdr"],
	},
	{
		name: "rex.socket",
		env: ["SOMA_REX_SOCKET", "/env/rex.sock"],
		file: { rex: { socket: "/file/rex.sock" } },
		base: { env: { SOMA_AGENT_ADAPTER: "rex", SOMA_REX_SESSION_ID: "session:hangar" } },
		read: (c) => c.rex?.socket,
		values: ["/env/rex.sock", "/file/rex.sock", "/home/me/Library/Application Support/rex/server.sock"],
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

describe("the web page", () => {
	test("is on only with both a host and a port, from either source", () => {
		expect(resolveConfig(undefined, { SOMA_WEB_HOST: "100.101.102.103" }, HOME).web).toBeUndefined();
		expect(resolveConfig({ web: { port: 8790 } }, {}, HOME).web).toBeUndefined();
		expect(resolveConfig({ web: { port: 8790 } }, { SOMA_WEB_HOST: "100.101.102.103" }, HOME).web).toEqual({
			host: "100.101.102.103",
			port: 8790,
		});
	});
	test.each([
		"0.0.0.0",
		"::",
		"127.0.0.1",
		"192.168.1.10",
		"100.63.255.255",
		"100.128.0.1",
		"fd7a:115c:a1e1::1",
		"localhost",
		"my-mac.tail1234.ts.net",
	])("refuses %s, which is not one tailnet address", (host) => {
		expect(() => resolveConfig({ web: { host, port: 8790 } }, {}, HOME, "/c.json")).toThrow(
			new ConfigError(`/c.json: web.host: Expected one tailnet IP address`).message,
		);
		expect(() => resolveConfig(undefined, { SOMA_WEB_HOST: host }, HOME)).toThrow(ConfigError);
	});
	test("a port out of range in the file throws with the field", () => {
		const path = write(JSON.stringify({ web: { host: "100.101.102.103", port: 70000 } }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: web.port:`);
	});
});

describe("the web page in serve mode", () => {
	const SERVE = { origin: "https://nick-mac-mini.tail361ef.ts.net:8445", login: "musingfox@github" };
	test("listens on loopback with the origin and the login, from either source", () => {
		const expected = { host: "127.0.0.1", port: 8790, serve: SERVE };
		expect(resolveConfig({ web: { port: 8790, ...SERVE } }, {}, HOME).web).toEqual(expected);
		expect(
			resolveConfig(
				undefined,
				{ SOMA_WEB_PORT: "8790", SOMA_WEB_ORIGIN: SERVE.origin, SOMA_WEB_LOGIN: SERVE.login },
				HOME,
			).web,
		).toEqual(expected);
	});
	test("the environment beats the file for the origin and the login", () => {
		const file = { web: { port: 8790, origin: "https://file.ts.net:8445", login: "file@github" } };
		const env = { SOMA_WEB_ORIGIN: "https://env.ts.net:8445", SOMA_WEB_LOGIN: "env@github" };
		expect(resolveConfig(file, {}, HOME).web?.serve).toEqual({ origin: file.web.origin, login: file.web.login });
		expect(resolveConfig(file, env, HOME).web?.serve).toEqual({
			origin: env.SOMA_WEB_ORIGIN,
			login: env.SOMA_WEB_LOGIN,
		});
	});
	test("is off without a port, as the tailnet-IP mode is", () => {
		expect(resolveConfig({ web: SERVE }, {}, HOME).web).toBeUndefined();
	});
	test("takes the origin in its canonical form: the default port is dropped, the case folded", () => {
		for (const origin of ["https://My-Mac.ts.net:443", "https://my-mac.ts.net", "HTTPS://MY-MAC.TS.NET"]) {
			expect(resolveConfig({ web: { port: 8790, origin, login: "a@b" } }, {}, HOME).web?.serve?.origin).toBe(
				"https://my-mac.ts.net",
			);
		}
	});
	test("refuses an origin with no login, and a login with no origin, naming the missing field", () => {
		expect(() => resolveConfig({ web: { port: 8790, origin: SERVE.origin } }, {}, HOME, "/c.json")).toThrow(
			"/c.json: web.login: Required with web.origin",
		);
		expect(() => resolveConfig({ web: { port: 8790, login: SERVE.login } }, {}, HOME, "/c.json")).toThrow(
			"/c.json: web.origin: Required with web.login",
		);
		expect(() => resolveConfig(undefined, { SOMA_WEB_ORIGIN: SERVE.origin }, HOME)).toThrow(ConfigError);
	});
	test.each([
		["web.origin", { origin: SERVE.origin }],
		["web.login", { login: SERVE.login }],
		["web.origin", SERVE],
	])("refuses mixing the modes: web.host with %s set names web.host", (_, serve) => {
		expect(() =>
			resolveConfig({ web: { host: "100.101.102.103", port: 8790, ...serve } }, {}, HOME, "/c.json"),
		).toThrow("/c.json: web.host: Not allowed with");
		expect(() => resolveConfig({ web: { port: 8790, ...serve } }, { SOMA_WEB_HOST: "100.101.102.103" }, HOME)).toThrow(
			"web.host: Not allowed with",
		);
	});
	test.each(["127.0.0.1", "::1", "0.0.0.0", "192.168.1.10"])("still refuses web.host %s", (host) => {
		expect(() => resolveConfig({ web: { host, port: 8790, ...SERVE } }, {}, HOME, "/c.json")).toThrow(
			"/c.json: web.host:",
		);
		expect(() => resolveConfig({ web: { host, port: 8790 } }, {}, HOME, "/c.json")).toThrow("/c.json: web.host:");
	});
	test.each([
		"http://my-mac.ts.net",
		"my-mac.ts.net",
		"https://",
		"https://my-mac.ts.net/",
		"https://my-mac.ts.net/soma",
		"https://my-mac.ts.net:8445/soma",
		"https://my-mac.ts.net?x=1",
		"https://my-mac.ts.net#top",
		"https://me@my-mac.ts.net",
		"https://my-mac.ts.net:99999",
		"wss://my-mac.ts.net",
	])("refuses the origin %s", (origin) => {
		expect(() => resolveConfig({ web: { port: 8790, origin, login: SERVE.login } }, {}, HOME, "/c.json")).toThrow(
			"/c.json: web.origin: Expected an https:// origin",
		);
	});
	test("an empty login in the file throws with the field", () => {
		const path = write(JSON.stringify({ web: { port: 8790, origin: SERVE.origin, login: "" } }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: web.login:`);
	});
});

describe("the vault", () => {
	test("is on only with a name, and denies nothing unless told", () => {
		expect(resolveConfig(undefined, {}, HOME).vault).toBeUndefined();
		expect(resolveConfig({ vault: { deny: ["Clippings"] } }, {}, HOME).vault).toBeUndefined();
		expect(resolveConfig({ vault: { name: "obsidian" } }, {}, HOME).vault).toEqual({ name: "obsidian", deny: [] });
		expect(resolveConfig({ vault: { name: "obsidian", deny: ["Clippings"] } }, {}, HOME).vault).toEqual({
			name: "obsidian",
			deny: ["Clippings"],
		});
	});
	test("an unknown vault field throws with its name", () => {
		const path = write(JSON.stringify({ vault: { name: "obsidian", path: "/x" } }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: vault.path:`);
	});
});

describe("invalid environment variables", () => {
	test.each([
		["SOMA_HANGAR_CAP", "0"],
		["SOMA_HANGAR_CAP", "four"],
		["SOMA_COMPACT_AT", "0"],
		["SOMA_COMPACT_AT", "-5"],
		["SOMA_COMPACT_AT", "1.5"],
		["SOMA_COMPACT_AT", "100k"],
		["SOMA_PROGRAM_STATUS", "yes"],
		["SOMA_REFLECTION", "off"],
		["TELEGRAM_CHAT_ID", "me"],
		["SOMA_LANGUAGE", "繁體中文"],
		["SOMA_AGENT_ADAPTER", "tmux"],
		["SOMA_WEB_PORT", "0"],
		["SOMA_WEB_PORT", "65536"],
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
	test.each([0, -1, 1.5, "100000"])("a compactAt of %j throws with the path and the field", (compactAt) => {
		const path = write(JSON.stringify({ compactAt }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(ConfigError);
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: compactAt:`);
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

describe("the agent-side adapter", () => {
	test("unset, it is herdr, and no rex setting is read", () => {
		const config = resolveConfig(undefined, { SOMA_REX_SESSION_ID: "not an id" }, HOME);
		expect(config.agentAdapter).toBe("herdr");
		expect(config.rex).toBeUndefined();
	});
	test("tty needs no settings of its own", () => {
		const config = resolveConfig({ agentAdapter: "tty" }, {}, HOME);
		expect(config.agentAdapter).toBe("tty");
		expect(config.rex).toBeUndefined();
	});
	test("acp needs no settings of its own, from the file or the environment", () => {
		expect(resolveConfig({ agentAdapter: "acp" }, {}, HOME)).toMatchObject({ agentAdapter: "acp" });
		const config = resolveConfig(undefined, { SOMA_AGENT_ADAPTER: "acp" }, HOME);
		expect(config.agentAdapter).toBe("acp");
		expect(config.rex).toBeUndefined();
	});
	test("acp with a hangar session named takes the rex settings, from the file or the environment", () => {
		const file: FileConfig = { agentAdapter: "acp", rex: { sessionId: "session:file", socket: "/tmp/rex.sock" } };
		expect(resolveConfig(file, {}, HOME)).toMatchObject({
			agentAdapter: "acp",
			rex: { sessionId: "session:file", socket: "/tmp/rex.sock" },
		});
		const config = resolveConfig(undefined, { SOMA_AGENT_ADAPTER: "acp", SOMA_REX_SESSION_ID: "session:env" }, HOME);
		expect(config.rex?.sessionId).toBe("session:env");
		expect(config.rex?.socket).toBe("/home/me/Library/Application Support/rex/server.sock");
	});
	test("acp with a socket and no hangar session runs alone", () => {
		expect(resolveConfig({ agentAdapter: "acp", rex: { socket: "/tmp/rex.sock" } }, {}, HOME).rex).toBeUndefined();
	});
	test("acp with a rex block it cannot use throws, naming the field", () => {
		const session = write(JSON.stringify({ agentAdapter: "acp", rex: { sessionId: "fleet" } }));
		expect(() => loadConfig(session, {}, HOME)).toThrow(`${session}: rex.sessionId: Expected a rex session id`);
		const key = write(JSON.stringify({ agentAdapter: "acp", rex: { session: "session:hangar" } }));
		expect(() => loadConfig(key, {}, HOME)).toThrow(`${key}: rex.session: Unrecognized key`);
	});
	test("a hangar session named under herdr or tty sets no rex settings", () => {
		const rex = { sessionId: "session:hangar" };
		expect(resolveConfig({ rex }, {}, HOME).rex).toBeUndefined();
		expect(resolveConfig({ agentAdapter: "tty", rex }, {}, HOME).rex).toBeUndefined();
	});
	test("an unknown one in the file throws with the path and the field", () => {
		const path = write(JSON.stringify({ agentAdapter: "tmux" }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(ConfigError);
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: agentAdapter: Invalid enum value`);
	});
	test("rex without the hangar's session id throws with the path and the field", () => {
		const path = write(JSON.stringify({ agentAdapter: "rex", rex: { socket: "/tmp/rex.sock" } }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(ConfigError);
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: rex.sessionId: Required`);
	});
	test("the label of a hangar soma makes is the file's rex.label, unset when the file sets none", () => {
		const rex = { sessionId: "session:hangar" };
		expect(resolveConfig({ agentAdapter: "rex", rex: { ...rex, label: "fleet" } }, {}, HOME).rex?.label).toBe("fleet");
		expect(resolveConfig({ agentAdapter: "rex", rex }, {}, HOME).rex).not.toHaveProperty("label");
		const long = write(JSON.stringify({ agentAdapter: "rex", rex: { ...rex, label: "x".repeat(129) } }));
		expect(() => loadConfig(long, {}, HOME)).toThrow(`${long}: rex.label:`);
	});
	test("the hangar's session id comes from SOMA_REX_SESSION_ID, else the file", () => {
		const file: FileConfig = { agentAdapter: "rex", rex: { sessionId: "session:file" } };
		expect(resolveConfig(file, { SOMA_REX_SESSION_ID: "session:env" }, HOME).rex?.sessionId).toBe("session:env");
		expect(resolveConfig(file, { SOMA_REX_SESSION_ID: " " }, HOME).rex?.sessionId).toBe("session:file");
	});
	test("rex selected by the environment without a session id throws too", () => {
		expect(() => resolveConfig(undefined, { SOMA_AGENT_ADAPTER: "rex" }, HOME)).toThrow(ConfigError);
	});
	test.each([
		["an empty session id", { sessionId: "" }, "rex.sessionId: String must contain at least 1 character(s)"],
		["a socket that is not a string", { socket: 7 }, "rex.socket: Expected string, received number"],
		["an unknown key", { session: "session:hangar" }, "rex.session: Unrecognized key"],
		["a block that is not an object", "session:hangar", "rex: Expected object, received string"],
	])("a rex block with %s is ignored under herdr and names the field under rex", (_, rex, field) => {
		const herdr = write(JSON.stringify({ agentAdapter: "herdr", rex }));
		expect(loadConfig(herdr, {}, HOME).agentAdapter).toBe("herdr");
		expect(loadConfig(write(JSON.stringify({ rex })), {}, HOME).rex).toBeUndefined();
		const path = write(JSON.stringify({ agentAdapter: "rex", rex }));
		expect(() => loadConfig(path, { SOMA_REX_SESSION_ID: "session:env" }, HOME)).toThrow(ConfigError);
		expect(() => loadConfig(path, { SOMA_REX_SESSION_ID: "session:env" }, HOME)).toThrow(`${path}: ${field}`);
	});
	test("a session label in place of the session id throws", () => {
		const path = write(JSON.stringify({ agentAdapter: "rex", rex: { sessionId: "fleet" } }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: rex.sessionId: Expected a rex session id`);
	});
});

describe("the permission warning", () => {
	test.each([
		["a key, readable by others", { anthropic: { apiKey: "k" } }, 0o604, true],
		["a token, readable by the group", { telegram: { botToken: "t" } }, 0o640, true],
		["an Exa key, readable by others", { exa: { apiKey: "k" } }, 0o604, true],
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

describe("push policies", () => {
	const INSTANT = { action: "ring", outcome: "ring", ambient: "ring" };
	const ASK = { action: "ring", outcome: "log", ambient: "log" };

	test("unset, every interface is instant, which is how soma pushed before", () => {
		expect(resolveConfig(undefined, {}, HOME).push).toEqual({ telegram: INSTANT, terminal: INSTANT, web: INSTANT });
		expect(resolveConfig({ push: {} }, {}, HOME).push).toEqual({ telegram: INSTANT, terminal: INSTANT, web: INSTANT });
	});

	test("a preset name or a table of all three classes, per interface", () => {
		const custom = { action: "quiet", outcome: "ring", ambient: "log" };
		const path = write(JSON.stringify({ push: { telegram: "ask", web: custom, terminal: "instant" } }));
		expect(loadConfig(path, {}, HOME).push).toEqual({ telegram: ASK, terminal: INSTANT, web: custom });
	});

	test("no environment variable sets it", () => {
		expect(resolveConfig(undefined, { SOMA_PUSH: "ask", SOMA_PUSH_TELEGRAM: "ask" }, HOME).push.telegram).toEqual(
			INSTANT,
		);
	});

	test("summary holds every class, and a table may hold any class", () => {
		const custom = { action: "ring", outcome: "hold", ambient: "hold" };
		const path = write(JSON.stringify({ push: { telegram: "summary", web: custom } }));
		expect(loadConfig(path, {}, HOME).push).toEqual({
			telegram: { action: "hold", outcome: "hold", ambient: "hold" },
			terminal: INSTANT,
			web: custom,
		});
	});

	test("the summary comes after 30 idle minutes unless push.summary.idleMinutes says otherwise", () => {
		expect(resolveConfig(undefined, {}, HOME).summaryIdleMs).toBe(30 * 60_000);
		expect(resolveConfig({ push: { summary: {} } }, {}, HOME).summaryIdleMs).toBe(30 * 60_000);
		const path = write(JSON.stringify({ push: { telegram: "summary", summary: { idleMinutes: 45 } } }));
		expect(loadConfig(path, {}, HOME).summaryIdleMs).toBe(45 * 60_000);
		expect(resolveConfig({ push: { summary: { idleMinutes: 0.1 } } }, {}, HOME).summaryIdleMs).toBe(6_000);
	});

	test.each([
		[
			{ telegram: "quiet" },
			'push.telegram: Unknown preset "quiet"; expected a preset ("instant", "ask", "summary") or a table',
		],
		[{ web: 3 }, "push.web: Expected a preset"],
		[{ web: ["ask"] }, "push.web: Expected a preset"],
		[{ fax: "ask" }, "push.fax: Unrecognized key"],
		[
			{ terminal: { action: "loud", outcome: "ring", ambient: "log" } },
			'push.terminal.action: Unknown policy "loud"; expected "ring", "quiet", "hold", "log"',
		],
		[{ summary: { idleMinutes: 0 } }, "push.summary.idleMinutes: Number must be greater than 0"],
		[{ summary: { idleMinutes: "30" } }, "push.summary.idleMinutes: Expected number"],
		[{ summary: { at: "08:00" } }, "push.summary.at: Unrecognized key"],
		[{ summary: 30 }, "push.summary: Expected object"],
		[{ terminal: { action: "ring", outcome: "ring" } }, "push.terminal.ambient: Required: a table sets"],
		[{ terminal: { ...INSTANT, urgent: "ring" } }, "push.terminal.urgent: Unrecognized key"],
		[{ terminal: { ...INSTANT, action: 1 } }, "push.terminal.action: Expected string"],
	])("%j is a config error naming its path", (push, message) => {
		const path = write(JSON.stringify({ push }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(ConfigError);
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: ${message}`);
	});

	test("a push that is not an object is a config error", () => {
		const path = write(JSON.stringify({ push: "ask" }));
		expect(() => loadConfig(path, {}, HOME)).toThrow(`${path}: push: Expected object`);
	});
});
