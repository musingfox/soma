// Drives index.html in headful Chromium, so WebGL draws on the hardware GPU,
// at 375 x 812: the renderer string and one screenshot per view plus one
// mid-switch. Exits non-zero when the renderer is SwiftShader. Not loaded by
// the page. Usage (with the folder served):
//   URL=http://100.88.181.24:8791/index.html node tools/capture.mjs [outDir]
// CHROME names the browser; PUPPETEER the puppeteer-core entry file, which is
// not installed in this repo.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const entry = process.env.PUPPETEER ?? `${homedir()}/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`;
const puppeteer = (await import(entry)).default;
const url = process.env.URL ?? "http://100.88.181.24:8791/index.html";
const out = process.argv[2] ?? "screenshots";
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
	executablePath: process.env.CHROME ?? "/Applications/Chromium.app/Contents/MacOS/Chromium",
	headless: false,
	args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
try {
	const page = await browser.newPage();
	await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

	// page.evaluate runs in an isolated world with this puppeteer and Chromium,
	// where window.house is not visible, and its console and pageerror events
	// stay silent, so use the protocol directly.
	const cdp = await page.createCDPSession();
	const errors = [];
	cdp.on("Runtime.exceptionThrown", (e) => {
		const msg = e.exceptionDetails.exception?.description ?? e.exceptionDetails.text;
		errors.push(msg);
		console.log("page error:", msg);
	});
	await cdp.send("Runtime.enable");
	const run = async (fn, ...args) => {
		const expression = `(${fn})(...${JSON.stringify(args)})`;
		const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	};
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const settle = async () => {
		const end = Date.now() + 8000;
		while (await run(() => window.house.scene.moving)) {
			if (Date.now() > end) throw new Error("the scene did not settle");
			await wait(100);
		}
		await wait(300);
	};

	await page.goto(url, { waitUntil: "networkidle0" });
	const end = Date.now() + 10000;
	while (!(await run(() => Boolean(window.house)))) {
		if (Date.now() > end) throw new Error("window.house never appeared");
		await wait(100);
	}

	const renderer = await run(() => {
		const gl = window.house.scene.renderer.getContext();
		const ext = gl.getExtension("WEBGL_debug_renderer_info");
		return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
	});
	console.log("renderer:", renderer);

	const shots = [];
	const shot = async (name) => {
		const path = `${out}/${name}.png`;
		await page.screenshot({ path });
		shots.push(path);
	};

	await run(() => window.house.setState("idle"));
	await settle();
	await shot("2d-idle");

	await run(() => window.house.setView("3d"));
	await settle();
	await shot("3d-idle");

	// A real mouse drag far past the right limit, then back to the start.
	const drag = async (dx, dy) => {
		await page.mouse.move(190, 600);
		await page.mouse.down();
		for (let i = 1; i <= 20; i++) await page.mouse.move(190 + (dx * i) / 20, 600 + (dy * i) / 20);
		await page.mouse.up();
		await wait(200);
		return run(() => window.house.scene.orbit);
	};
	const orbitStart = await run(() => window.house.scene.orbit);
	const orbitLimit = await drag(-400, -300);
	await settle();
	await shot("3d-drag-limit");
	await run((o) => window.house.setOrbit(o.az, o.el), orbitStart);
	await settle();

	await run(() => window.house.setViewBlend(0.5));
	await wait(400);
	await shot("blend-0.5-idle");
	await run(() => window.house.setViewBlend(null));

	// Each state: the fox's position a few times during the move, then where it ended.
	const states = {};
	for (const name of ["sleeping", "working", "thinking", "listening", "talking", "happy", "worried", "idle"]) {
		await run((n) => window.house.setState(n), name);
		const path = [];
		for (let i = 0; i < 6; i++) {
			await wait(150);
			path.push((await run(() => window.house.scene.foxAt)).map((v) => +v.toFixed(2)));
		}
		await settle();
		states[name] = { path, end: (await run(() => window.house.scene.foxAt)).map((v) => +v.toFixed(2)) };
	}

	// Reduced motion: once settled, nothing is drawn.
	await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
	await run(() => window.house.setState("thinking"));
	await settle();
	await wait(2200);
	const reducedSettledFrames = (await run(() => window.house.stats())).frames;
	await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
	await run(() => window.house.setState("idle"));
	await settle();

	await page.click("#debug-toggle");
	await wait(600);
	const layout = await run(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		scrollHeight: document.documentElement.scrollHeight,
		innerWidth,
		innerHeight,
		devicePixelRatio,
	}));
	await shot("debug-open");

	const measurements = {
		at: new Date().toISOString(),
		url,
		headless: false,
		renderer,
		userAgent: await browser.version(),
		viewport: { width: 375, height: 812, deviceScaleFactor: 2 },
		layout,
		orbit: { start: orbitStart, afterDragPastLimit: orbitLimit },
		states,
		reducedSettledFrames,
		screenshots: shots,
		errors,
	};
	writeFileSync(`${out}/measurements.json`, `${JSON.stringify(measurements, null, "\t")}\n`);
	console.log(JSON.stringify(measurements, null, 2));

	if (!renderer || /SwiftShader/i.test(renderer)) {
		console.error("not drawn on a hardware GPU:", renderer);
		process.exitCode = 1;
	}
	if (errors.length) process.exitCode = 1;
} finally {
	await browser.close();
}
