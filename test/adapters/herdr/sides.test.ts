// Ported from musingfox/cc-mobile server/herdr/sides.test.ts @ d9f0690; the Bun fake daemon replaced with node:net.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createHerdrClient, SUPPORTED_PROTOCOL } from "../../../src/adapters/herdr/client.ts";
import { hangarKey, resolveHerdrSides, routeSessionKey } from "../../../src/adapters/herdr/sides.ts";

const savedEnv = process.env.HERDR_SOCKET_PATH;
const dirs: string[] = [];
afterEach(() => {
	if (savedEnv === undefined) delete process.env.HERDR_SOCKET_PATH;
	else process.env.HERDR_SOCKET_PATH = savedEnv;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeDaemon(path: string): Promise<Server> {
	const server = createServer((socket) => {
		socket.on("data", (chunk) => {
			const { id } = JSON.parse(chunk.toString());
			const result = { type: "pong", version: "x", protocol: SUPPORTED_PROTOCOL };
			socket.end(`${JSON.stringify({ id, result })}\n`);
		});
	});
	return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

describe("resolveHerdrSides", () => {
	test("T1: no hangar yields only the default cockpit socket", () => {
		delete process.env.HERDR_SOCKET_PATH;
		const sides = resolveHerdrSides(null);
		expect(sides).toEqual([{ side: "cockpit", socketPath: join(homedir(), ".config/herdr/herdr.sock") }]);
		expect(sides).toHaveLength(1);
	});

	test("T2: env moves only the cockpit; hangar binds its session socket", () => {
		process.env.HERDR_SOCKET_PATH = "/tmp/cockpit.sock";
		expect(resolveHerdrSides("fleet", "/h")).toEqual([
			{ side: "cockpit", socketPath: "/tmp/cockpit.sock" },
			{ side: "hangar", name: "fleet", socketPath: "/h/.config/herdr/sessions/fleet/herdr.sock" },
		]);
	});

	test("T3: an explicit socket path binds even when HERDR_SOCKET_PATH points elsewhere", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hs-"));
		dirs.push(dir);
		process.env.HERDR_SOCKET_PATH = join(dir, "none.sock");
		const server = await fakeDaemon(join(dir, "h.sock"));
		try {
			const client = createHerdrClient({ socketPath: join(dir, "h.sock") });
			const pong = await client.assertCompatible();
			expect(pong.protocol).toBe(SUPPORTED_PROTOCOL);
		} finally {
			server.close();
		}
	});
});

describe("session key codec", () => {
	test("T1: hangarKey joins name and pane id", () => {
		expect(hangarKey("fleet", "w1:p1")).toBe("fleet@w1:p1");
	});
	test("T2: hangar-prefixed key routes to the hangar", () => {
		expect(routeSessionKey("fleet@w1:p1", "fleet")).toEqual({ side: "hangar", paneId: "w1:p1" });
	});
	test("T3: bare key stays cockpit", () => {
		expect(routeSessionKey("w1:p1", "fleet")).toEqual({ side: "cockpit", paneId: "w1:p1" });
	});
	test("T4: no hangar configured keeps the key verbatim", () => {
		expect(routeSessionKey("fleet@w1:p1", null)).toEqual({
			side: "cockpit",
			paneId: "fleet@w1:p1",
		});
	});
	test("T5: another name's prefix is not routed", () => {
		expect(routeSessionKey("other@w1:p1", "fleet")).toEqual({
			side: "cockpit",
			paneId: "other@w1:p1",
		});
	});
	test("T6: a longer name sharing the prefix is not routed", () => {
		expect(routeSessionKey("fleetx@w1:p1", "fleet")).toEqual({
			side: "cockpit",
			paneId: "fleetx@w1:p1",
		});
	});
	test("T7: empty remainder is not routed", () => {
		expect(routeSessionKey("fleet@", "fleet")).toEqual({ side: "cockpit", paneId: "fleet@" });
	});
	test("T8: a uuid stays cockpit", () => {
		const uuid = "3f2a9b01-1111-4222-8333-444455556666";
		expect(routeSessionKey(uuid, "fleet")).toEqual({ side: "cockpit", paneId: uuid });
	});
	test("T9: round trip", () => {
		expect(routeSessionKey(hangarKey("fleet", "wHQ:p12"), "fleet").paneId).toBe("wHQ:p12");
	});
});
