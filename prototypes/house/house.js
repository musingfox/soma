// The debug panel over the house, and `window.house` for the capture script.
import { STATES } from "./fox.js";
import { createHouse } from "./scene.js";

const $ = (id) => document.getElementById(id);
const house = createHouse($("scene"));

const toggle = $("debug-toggle");
const panel = $("debug");
toggle.addEventListener("click", () => {
	panel.hidden = !panel.hidden;
	toggle.setAttribute("aria-expanded", String(!panel.hidden));
});

const viewButtons = new Map();
for (const v of ["2d", "3d"]) {
	const b = document.createElement("button");
	b.type = "button";
	b.textContent = v.toUpperCase();
	b.addEventListener("click", () => {
		house.setView(v);
		sync();
	});
	$("views").appendChild(b);
	viewButtons.set(v, b);
}

const stateButtons = new Map();
for (const name of STATES) {
	const b = document.createElement("button");
	b.type = "button";
	b.textContent = name;
	b.addEventListener("click", () => {
		house.setState(name);
		sync();
	});
	$("states").appendChild(b);
	stateButtons.set(name, b);
}

const mouth = $("mouth");
mouth.addEventListener("input", () => {
	house.setMouth(Number(mouth.value));
	$("mouth-out").textContent = Number(mouth.value).toFixed(2);
});

const tempo = $("tempo");
tempo.addEventListener("input", () => {
	house.setTempo(Number(tempo.value));
	$("tempo-out").textContent = `${Number(tempo.value).toFixed(2)}×`;
});

function sync() {
	for (const [v, b] of viewButtons) b.setAttribute("aria-pressed", String(house.view === v));
	for (const [name, b] of stateButtons) b.setAttribute("aria-pressed", String(house.state === name));
}

const readout = $("readout");
const ms = (v) => v.toFixed(1).padStart(5);
setInterval(() => {
	if (panel.hidden) return;
	const s = house.stats();
	readout.textContent = s.frames
		? `last 2 s: ${s.frames} frames, ${house.state}, ${house.view}\nframe avg ${ms(s.intervalAvg)} worst ${ms(s.intervalMax)} ms\nwork  avg ${ms(s.workAvg)} worst ${ms(s.workMax)} ms`
		: `last 2 s: no frames drawn (nothing moving), ${house.state}, ${house.view}`;
}, 250);

sync();
window.house = {
	setState(name) {
		house.setState(name);
		sync();
	},
	setView(v) {
		house.setView(v);
		sync();
	},
	setMouth: house.setMouth,
	setTempo: house.setTempo,
	setViewBlend: house.setViewBlend,
	setOrbit: house.setOrbit,
	stats: house.stats,
	scene: house,
};
