// The page around the house: the socket to soma, the words typed to the fox, its speech bubbles, which state it is in,
// and the debug panel.
import { STATES } from "./fox.js";
import { renderMarkdown } from "./markdown.js";
import { createHouse } from "./scene.js";

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const bubble = $("bubble");
const bubbleText = $("bubble-text");
const form = $("say");
const text = $("text");
const statusLine = $("status");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const house = createHouse($("scene"), { onFrame: placeBubble });

// ---- which state the fox is in ----

let running = false;
/** Ids typed and sent whose turn has not started yet: the fox listens until it does. */
const awaiting = new Set();
/** A state the debug panel holds, over everything soma says. */
let held = null;
let shown = null;

function wantedState() {
	if (held) return held;
	if (shown) return shown.kind === "failure" ? "worried" : "talking";
	if (running) return "thinking";
	if (awaiting.size > 0) return "listening";
	return "idle";
}

function settle() {
	house.setState(wantedState());
	syncPanel();
}

// ---- speech bubbles ----

const queue = [];
let revealTimer = 0;
let holdTimer = 0;
let fadeTimer = 0;
const FADE_MS = 1200;
const REVEAL_MIN_MS = 1200;
const REVEAL_MAX_MS = 4000;
const REVEAL_MS_PER_CHAR = 60;

/** How long a fully shown bubble stays before it fades: longer for more to read. */
const holdMs = (words) => Math.min(45_000, Math.max(6000, 3000 + words.length * 60));

/** Queues a bubble; `kind` is answer, notice or failure, `label` a short heading, and a quiet one does not ring. */
function say(kind, words, { label = "", quiet = false } = {}) {
	queue.push({ kind, words, label, quiet });
	if (!shown) showNext();
	else updateHead();
}

/** The bubble's heading: its label, and how many more wait behind it. */
function updateHead() {
	bubble.dataset.head = [shown?.label, queue.length > 0 ? `+${queue.length}` : ""].filter(Boolean).join(" · ");
}

function showNext() {
	clearTimeout(holdTimer);
	clearTimeout(fadeTimer);
	shown = queue.shift() ?? null;
	updateHead();
	if (!shown) {
		bubble.hidden = true;
		house.speak(false);
		settle();
		return;
	}
	bubble.hidden = false;
	bubble.className = `bubble ${shown.kind}${shown.quiet ? " quiet" : ""}`;
	bubbleText.className = "";
	bubbleText.textContent = "";
	settle();
	placeBubble();
	if (shown.kind !== "failure") house.speak(true);
	clearInterval(revealTimer);
	if (reducedMotion.matches) return finishReveal();
	// The words appear as the fox says them: long enough for the mouth to be seen moving, a few seconds at most.
	const words = shown.words;
	const started = performance.now();
	const duration = Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, words.length * REVEAL_MS_PER_CHAR));
	revealTimer = setInterval(() => {
		const shownChars = Math.floor((words.length * (performance.now() - started)) / duration);
		bubbleText.textContent = words.slice(0, shownChars);
		placeBubble();
		if (shownChars >= words.length) finishReveal();
	}, 33);
}

/** The words as rendered markdown, built as DOM nodes; if that throws, the plain words stay. */
function showRendered(words) {
	try {
		bubbleText.replaceChildren(renderMarkdown(words));
		bubbleText.className = "md";
	} catch (error) {
		console.error("markdown", error);
		bubbleText.className = "";
		bubbleText.textContent = words;
	}
}

function finishReveal() {
	clearInterval(revealTimer);
	revealTimer = 0;
	showRendered(shown.words);
	house.speak(false);
	placeBubble();
	startHold();
}

// The hold runs only while the page is in view, so words that arrive while the human is away wait for them.
function startHold() {
	clearTimeout(holdTimer);
	if (!shown || revealTimer || document.hidden) return;
	holdTimer = setTimeout(fade, holdMs(shown.words));
}

function fade() {
	clearTimeout(holdTimer);
	bubble.classList.add("fading");
	fadeTimer = setTimeout(showNext, reducedMotion.matches ? 0 : FADE_MS);
}

// A tap shows the rest at once, or, once all is shown, lets the bubble go.
bubble.addEventListener("click", () => {
	if (!shown || bubble.classList.contains("fading")) return;
	if (revealTimer) finishReveal();
	else fade();
});

document.addEventListener("visibilitychange", () => {
	if (document.hidden) clearTimeout(holdTimer);
	else {
		document.title = "soma";
		startHold();
	}
});

function placeBubble() {
	if (bubble.hidden) return;
	const { x, y } = house.anchorOnScreen();
	const width = stage.clientWidth;
	const margin = 12;
	bubbleText.style.maxHeight = `${Math.max(96, y - 4 * margin)}px`;
	bubble.style.bottom = `${stage.clientHeight - y + 14}px`;
	const left = Math.min(Math.max(margin, x - bubble.offsetWidth / 2), width - bubble.offsetWidth - margin);
	bubble.style.left = `${left}px`;
	bubble.style.setProperty("--tail", `${Math.min(Math.max(18, x - left), bubble.offsetWidth - 18)}px`);
}

// A push meant for this page rings by marking the tab until the human comes back to it.
function ring() {
	if (document.visibilityState !== "visible") document.title = "● soma";
}

// ---- words the human types fly to the fox and go ----

function fly(words) {
	const from = text.getBoundingClientRect();
	const to = house.anchorOnScreen();
	const stageBox = stage.getBoundingClientRect();
	const flying = document.createElement("div");
	flying.className = "flying";
	flying.textContent = words.length > 80 ? `${words.slice(0, 80)}…` : words;
	flying.style.left = `${from.left}px`;
	flying.style.top = `${from.top}px`;
	flying.style.maxWidth = `${from.width}px`;
	document.body.append(flying);
	const dx = stageBox.left + to.x - (from.left + flying.offsetWidth / 2);
	const dy = stageBox.top + to.y - (from.top + flying.offsetHeight / 2);
	const animation = flying.animate(
		reducedMotion.matches
			? [{ opacity: 1 }, { opacity: 0 }]
			: [
					{ transform: "translate(0, 0) scale(1)", opacity: 1 },
					{ transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) scale(0.7)`, opacity: 0.9, offset: 0.6 },
					{ transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0 },
				],
		{ duration: reducedMotion.matches ? 300 : 800, easing: "ease-in" },
	);
	animation.onfinish = () => flying.remove();
}

// ---- the socket ----

// Sent and not yet admitted, by id: resent with the same id after a reconnect, so the core admits each once.
const pending = new Map();
let socket;
let connected = false;
let retryMs = 500;

// crypto.randomUUID needs a secure context, and the page is plain HTTP over the tailnet.
const newId = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

function showStatus() {
	statusLine.hidden = connected;
}

function send(id, words) {
	if (connected) socket.send(JSON.stringify({ type: "input", id, text: words }));
}

function receive(message) {
	if (message.type === "run") {
		running = message.state === "working";
		if (running) awaiting.clear();
		settle();
	} else if (message.type === "accepted") {
		pending.delete(message.id);
	} else if (message.type === "answer") {
		awaiting.delete(message.id);
		say("answer", message.text);
		ring();
	} else if (message.type === "notice") {
		say("notice", message.text, { label: message.kind === "question" ? "問題" : "通知", quiet: !message.loud });
		if (message.loud) ring();
	} else if (message.type === "failure") {
		if (message.id !== undefined) {
			pending.delete(message.id);
			awaiting.delete(message.id);
		}
		say("failure", message.text, { label: "失敗", quiet: !message.loud });
		if (message.loud) ring();
	} else if (message.type === "error") {
		say("failure", message.text, { label: "錯誤" });
	}
}

function connect() {
	socket = new WebSocket(new URL("/socket", location.href.replace(/^http/, "ws")));
	socket.onopen = () => {
		connected = true;
		retryMs = 500;
		showStatus();
		for (const [id, words] of pending) send(id, words);
	};
	socket.onmessage = (event) => receive(JSON.parse(event.data));
	socket.onclose = () => {
		connected = false;
		showStatus();
		setTimeout(connect, retryMs);
		retryMs = Math.min(retryMs * 2, 10_000);
	};
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const words = text.value.trim();
	if (words === "") return;
	const id = newId();
	pending.set(id, words);
	awaiting.add(id);
	fly(words);
	send(id, words);
	text.value = "";
	text.style.height = "";
	settle();
});
// Enter sends on a keyboard; Shift+Enter, and a phone's IME composing, keep the line.
text.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		form.requestSubmit();
	}
});
text.addEventListener("input", () => {
	text.style.height = "";
	text.style.height = `${text.scrollHeight}px`;
});

// ---- the debug panel ----

const toggle = $("debug-toggle");
const panel = $("debug");
toggle.addEventListener("click", () => {
	panel.hidden = !panel.hidden;
	toggle.setAttribute("aria-expanded", String(!panel.hidden));
});

function addButton(parent, label, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.addEventListener("click", onClick);
	parent.append(button);
	return button;
}

const viewButtons = new Map(
	["2d", "3d"].map((view) => [
		view,
		addButton($("views"), view.toUpperCase(), () => {
			house.setView(view);
			syncPanel();
		}),
	]),
);
// "auto" gives the fox back to soma; a state button holds the fox in that state.
const stateButtons = new Map(
	["auto", ...STATES].map((name) => [
		name,
		addButton($("states"), name, () => {
			held = name === "auto" ? null : name;
			house.setMouth(held ? Number(mouth.value) : 0);
			settle();
		}),
	]),
);

const mouth = $("mouth");
mouth.addEventListener("input", () => {
	$("mouth-out").textContent = Number(mouth.value).toFixed(2);
	if (held) house.setMouth(Number(mouth.value));
});
const tempo = $("tempo");
tempo.addEventListener("input", () => {
	house.setTempo(Number(tempo.value));
	$("tempo-out").textContent = `${Number(tempo.value).toFixed(2)}×`;
});

function syncPanel() {
	for (const [view, button] of viewButtons) button.setAttribute("aria-pressed", String(house.view === view));
	for (const [name, button] of stateButtons) {
		button.setAttribute("aria-pressed", String(name === "auto" ? held === null : house.state === name));
	}
}

const readout = $("readout");
const ms = (value) => value.toFixed(1).padStart(5);
setInterval(() => {
	if (panel.hidden) return;
	const stats = house.stats();
	const where = `${house.state}${held ? " (held)" : ""}, ${house.view}`;
	readout.textContent = stats.frames
		? `last 2 s: ${stats.frames} frames, ${where}\n` +
			`frame avg ${ms(stats.intervalAvg)} worst ${ms(stats.intervalMax)} ms\n` +
			`work  avg ${ms(stats.workAvg)} worst ${ms(stats.workMax)} ms`
		: `last 2 s: no frames drawn (nothing moving), ${where}`;
}, 250);

window.house = house;
settle();
showStatus();
connect();
