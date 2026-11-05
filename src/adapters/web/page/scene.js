// The house: the room and the fox in one scene, seen through one camera that blends between a fixed front orthographic
// view (2D) and a perspective view the finger turns (3D). It draws only while something moves.
import * as THREE from "three";
import { createFox } from "./fox.js";
import { buildRoom, COLORS } from "./room.js";
import { spring } from "./shapes.js";

const FOX_SCALE = 0.5;

// Each state is an action at a place. `route` leads from the open floor to the spot, so the fox walks around the bed
// and the desk rather than through them; `face` is its heading once there, 0 facing the viewer. Thinking paces between
// the two `pace` points.
const PLACES = {
	idle: { route: [[-1.8, 0.25, 1.2]], face: 0.2 },
	sleeping: {
		route: [
			[-1.3, 0, -0.45],
			[-2.7, 0.95, -1.7],
		],
		face: 0,
	},
	working: {
		route: [
			[1.25, 0, -0.5],
			[1.25, 0, -2.45],
			[2.85, 0.6, -2.45],
		],
		face: 0,
	},
	thinking: {
		route: [[-0.3, 0, 0.5]],
		face: 0,
		pace: [
			[-0.3, 0, 0.5],
			[1.4, 0, 0.5],
		],
	},
	listening: { route: [[0.3, 0, 1.9]], face: 0 },
	talking: { route: [[0.3, 0, 1.9]], face: 0 },
	happy: { route: [[0.3, 0, 1.9]], face: 0 },
	worried: { route: [[0.3, 0, 1.9]], face: 0 },
};

// At tempo 1. The tempo scales time: speeds by it, accelerations by its square, spring rates by it.
const WALK = {
	speed: 4.6,
	pace: 2.0,
	accel: 20,
	decel: 11.2,
	stride: 0.55,
	arrive: 0.25,
	land: 20,
	turn: 22,
	legs: 28,
	pause: 0.25,
};
// The fox turns toward its heading but never edge-on, where a card is a line; only a walk almost straight away shows
// its back.
const HEADING_CAP = 0.7;
const BACK_VIEW = 0.5;
const ROOM_NIGHT = new THREE.Color("#39406A");
const FOX_NIGHT = new THREE.Color("#8E92B8");

const VIEW_2D = { az: 0, el: 0.14 };
const ORBIT = { az: [-0.6, 0.6], el: [0.15, 0.6] };
// The turned room is wider on screen than the flat one, so 3D frames it looser.
const ZOOM_3D = 1.22;
const TARGET = new THREE.Vector3(0, 1.9, 0);
const FOV = THREE.MathUtils.degToRad(32);
const VIEW_SECONDS = 0.9;
const FPS_FAST = 60;
const FPS_SLOW = 30;
const STATS_MS = 2000;

const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Every material under `group` but the glowing ones, each remembering its colour as drawn. */
function tintable(group) {
	const found = new Set();
	group.traverse((object) => {
		if (!object.material) return;
		for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
			if (material.userData.glow) continue;
			material.userData.base ??= material.color.clone();
			found.add(material);
		}
	});
	return [...found];
}

/**
 * Draws the house into `container`, which CSS sizes. `onFrame` runs after each drawn frame, so what is laid over the
 * canvas can follow the fox.
 */
export function createHouse(container, { onFrame = () => {} } = {}) {
	const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setClearColor(COLORS.background);
	const canvas = renderer.domElement;
	canvas.style.display = "block";
	canvas.style.width = "100%";
	canvas.style.height = "100%";
	canvas.style.touchAction = "none";
	container.appendChild(canvas);

	const scene = new THREE.Scene();
	// A bare camera: its projection is set by hand from the view blend.
	const camera = new THREE.Camera();

	const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
	let reduced = reducedQuery.matches;
	reducedQuery.addEventListener("change", (event) => {
		reduced = event.matches;
		wake();
	});

	const { room, sideWalls } = buildRoom();
	scene.add(room);
	// actor: on the floor, turned to its heading.
	const actor = new THREE.Group();
	scene.add(actor);
	const fox = createFox({ scale: FOX_SCALE, isReduced: () => reduced });
	actor.add(fox.root);

	const roomMaterials = tintable(room);
	const foxMaterials = tintable(fox.root);
	const tint = new THREE.Color();
	const background = new THREE.Color(COLORS.background);
	const night = new THREE.Color(COLORS.night);
	let shownDim = -1;
	function applyDim(dim) {
		if (Math.abs(dim - shownDim) < 1e-4) return;
		shownDim = dim;
		tint.setRGB(1, 1, 1).lerp(ROOM_NIGHT, dim);
		for (const material of roomMaterials) material.color.copy(material.userData.base).multiply(tint);
		tint.setRGB(1, 1, 1).lerp(FOX_NIGHT, dim);
		for (const material of foxMaterials) material.color.copy(material.userData.base).multiply(tint);
		renderer.setClearColor(background.clone().lerp(night, dim));
	}

	// ---- where the fox is, and its walk ----

	let time = 0; // real seconds: walks and view switches ease even under reduced motion
	let clock = 0; // ambient seconds, standing still under reduced motion
	let tempo = 1;
	let state = "idle";
	let posed = true; // the state's pose is on; it waits until the fox arrives
	const [startX, startY, startZ] = PLACES.idle.route[0];
	const pos = { x: startX, y: startY, z: startZ };
	const vel = { x: 0, z: 0 };
	let path = []; // [{ p: [x, y, z], tag?: { place, index, leaving } }]
	let leg = { y: pos.y, length: 0 }; // where the current stretch of the path started
	let landing = false; // the last stretch: a spring onto the spot
	let zone = { place: "idle", depth: 1 }; // how far into a place's route the fox is
	let pauseUntil = 0;
	let paceIndex = 0;
	const yaw = { x: PLACES.idle.face, v: 0, target: PLACES.idle.face };
	const walk = { x: 0, v: 0, phase: 0 };
	let nextLook = 3;

	function beginLeg() {
		const [x, , z] = path[0].p;
		leg = { y: pos.y, length: Math.hypot(x - pos.x, z - pos.z) };
	}

	function setState(name) {
		if (!PLACES[name]) throw new Error(`unknown state: ${name}`);
		if (name === state) return;
		state = name;
		pauseUntil = 0;
		paceIndex = 0;
		fox.setOffsets({});
		const route = PLACES[name].route;
		const [hx, hy, hz] = route[route.length - 1];
		if (zone.place === name && !path.length && Math.hypot(hx - pos.x, hy - pos.y, hz - pos.z) < 0.05) {
			arrive();
			wake();
			return;
		}
		// Back out the way the fox came into its place, then in along the new route.
		const leaving = (PLACES[zone.place]?.route ?? [])
			.slice(0, Math.min(zone.depth, (PLACES[zone.place]?.route.length ?? 1) - 1))
			.map((p, index) => ({ p, tag: { place: zone.place, index, leaving: true } }))
			.reverse();
		path = [...leaving, ...route.map((p, index) => ({ p, tag: { place: name, index, leaving: false } }))];
		landing = false;
		posed = false;
		// While it walks, the fox holds the idle pose.
		fox.pose("idle");
		beginLeg();
		wake();
	}

	function arrive() {
		posed = true;
		fox.pose(state);
	}

	function reach(waypoint) {
		const { place, index, leaving } = waypoint.tag ?? {};
		if (place) zone = { place, depth: leaving ? index : index + 1 };
	}

	const pacing = () => state === "thinking" && posed && !reduced;

	function updateWalk(dt) {
		if (!path.length && pacing()) {
			if (!pauseUntil) pauseUntil = time + WALK.pause / tempo;
			if (time >= pauseUntil) {
				paceIndex = 1 - paceIndex;
				path = [{ p: PLACES.thinking.pace[paceIndex] }];
				landing = false;
				pauseUntil = 0;
				beginLeg();
			}
		}
		if (!path.length) return;
		const waypoint = path[0];
		const [tx, ty, tz] = waypoint.p;
		const dx = tx - pos.x;
		const dz = tz - pos.z;
		const distance = Math.hypot(dx, dz);
		const last = path.length === 1;
		const top = (waypoint.tag ? WALK.speed : WALK.pace) * tempo;

		if (last && distance < WALK.arrive) landing = true;
		if (landing) {
			// The last stretch springs onto the spot from the current velocity, so the stop eases.
			[pos.x, vel.x] = spring(pos.x, vel.x, tx, WALK.land * tempo, dt);
			[pos.z, vel.z] = spring(pos.z, vel.z, tz, WALK.land * tempo, dt);
		} else {
			const want = last ? Math.min(top, Math.sqrt(2 * WALK.decel * tempo * tempo * distance)) : top;
			let ax = (dx / distance) * want - vel.x;
			let az = (dz / distance) * want - vel.z;
			const a = Math.hypot(ax, az);
			const cap = WALK.accel * tempo * tempo * dt;
			if (a > cap) {
				ax *= cap / a;
				az *= cap / a;
			}
			vel.x += ax;
			vel.z += az;
			pos.x += vel.x * dt;
			pos.z += vel.z * dt;
		}

		// The height follows the stretch, with a hop when the fox climbs onto or off something.
		const left = Math.hypot(tx - pos.x, tz - pos.z);
		const u = leg.length > 1e-3 ? Math.min(1, Math.max(0, 1 - left / leg.length)) : 1;
		const climb = Math.abs(ty - leg.y) > 0.1 ? Math.sin(u * Math.PI) * 0.35 : 0;
		pos.y = leg.y + (ty - leg.y) * u + climb;

		const speed = Math.hypot(vel.x, vel.z);
		if (!last && left < 0.2) {
			reach(path.shift());
			beginLeg();
		} else if (last && left < 2e-3 && speed < 1e-2) {
			pos.x = tx;
			pos.y = ty;
			pos.z = tz;
			vel.x = vel.z = 0;
			reach(path.shift());
			landing = false;
			if (!posed) arrive();
		}
	}

	function updateFacing(dt) {
		const speed = Math.hypot(vel.x, vel.z);
		if (speed > 0.24 * tempo && !landing) {
			let heading = Math.atan2(vel.x, vel.z);
			const off = Math.abs(heading);
			if (off > HEADING_CAP && off < Math.PI - BACK_VIEW) heading = Math.sign(heading) * HEADING_CAP;
			yaw.target = heading;
		} else if (!path.length) {
			yaw.target = PLACES[state].face;
		}
		[yaw.x, yaw.v] = spring(yaw.x, yaw.v, yaw.x + wrap(yaw.target - yaw.x), WALK.turn * tempo, dt);
		[walk.x, walk.v] = spring(walk.x, walk.v, reduced ? 0 : Math.min(1, speed / tempo), WALK.legs * tempo, dt);
		walk.phase += (speed / WALK.stride) * Math.PI * dt;
	}

	// Settled in idle, the fox looks around now and then.
	function updateLook() {
		if (state !== "idle" || !posed || reduced || clock < nextLook) return;
		const turn = [-0.4, 0, 0.32, 0][Math.floor(Math.random() * 4)];
		fox.setOffsets({ yaw: turn, lookX: turn * 0.12 });
		nextLook = clock + 2.5 + Math.random() * 3;
	}

	// ---- the view ----

	let viewTarget = 0; // 0 is 2D, 1 is 3D
	let viewFrom = 0;
	let viewStart = -1;
	let frozenBlend = null;
	let blend = 0;
	const orbit = { az: 0.35, el: 0.32 };
	let dragging = null;
	const framing = { hw: 1, hh: 1, distance: 10 };
	const ortho = new THREE.Matrix4();
	const perspective = new THREE.Matrix4();

	function setView(view) {
		const next = view === "3d" ? 1 : 0;
		if (next === viewTarget) return;
		viewFrom = blend;
		viewTarget = next;
		viewStart = time;
		wake();
	}

	function updateBlend() {
		if (frozenBlend !== null) {
			blend = frozenBlend;
		} else if (viewStart < 0) {
			blend = viewTarget;
		} else {
			const span = VIEW_SECONDS * Math.max(0.2, Math.abs(viewTarget - viewFrom));
			const p = Math.min(1, (time - viewStart) / span);
			blend = viewFrom + (viewTarget - viewFrom) * easeInOut(p);
			if (p >= 1) viewStart = -1;
		}
	}

	function reframe() {
		const aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
		// The whole room across with a margin, and at least 5.4 units up.
		framing.hh = Math.max(5.4, 4.9 / aspect);
		framing.hw = framing.hh * aspect;
		framing.distance = framing.hh / Math.tan(FOV / 2);
	}

	// Both projections agree on the plane through the target, and the perspective one is scaled so its w is 1 there, so
	// blending them element by element stays a valid projection all the way from orthographic to perspective.
	function applyCamera() {
		const zoom = 1 + (ZOOM_3D - 1) * blend;
		const hw = framing.hw * zoom;
		const hh = framing.hh * zoom;
		const { distance } = framing;
		const near = distance - 14;
		const far = distance + 14;
		ortho.makeOrthographic(-hw, hw, hh, -hh, near, far);
		const k = near / distance;
		perspective.makePerspective(-hw * k, hw * k, hh * k, -hh * k, near, far).multiplyScalar(1 / distance);
		const o = ortho.elements;
		const p = perspective.elements;
		const out = camera.projectionMatrix.elements;
		for (let i = 0; i < 16; i++) out[i] = o[i] + (p[i] - o[i]) * blend;
		camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

		const az = VIEW_2D.az + (orbit.az - VIEW_2D.az) * blend;
		const el = VIEW_2D.el + (orbit.el - VIEW_2D.el) * blend;
		camera.position.set(
			TARGET.x + distance * Math.sin(az) * Math.cos(el),
			TARGET.y + distance * Math.sin(el),
			TARGET.z + distance * Math.cos(az) * Math.cos(el),
		);
		camera.lookAt(TARGET);
		camera.updateMatrixWorld();

		// Seen from outside, a side wall hides its half of the room: the one on the camera's side fades as the view turns.
		for (const wall of sideWalls) {
			const opacity = 1 - THREE.MathUtils.smoothstep(Math.sin(az) * wall.sign, 0.03, 0.22);
			wall.mesh.visible = opacity > 0.01;
			for (const material of wall.materials) material.opacity = opacity;
		}
	}

	canvas.addEventListener("pointerdown", (event) => {
		if (viewTarget !== 1 || frozenBlend !== null) return;
		dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
		canvas.setPointerCapture(event.pointerId);
		wake();
	});
	canvas.addEventListener("pointermove", (event) => {
		if (dragging?.id !== event.pointerId) return;
		orbit.az = clamp(orbit.az - (event.clientX - dragging.x) * 0.008, ORBIT.az);
		orbit.el = clamp(orbit.el + (event.clientY - dragging.y) * 0.006, ORBIT.el);
		dragging.x = event.clientX;
		dragging.y = event.clientY;
		wake();
	});
	const endDrag = (event) => {
		if (dragging?.id === event.pointerId) dragging = null;
	};
	canvas.addEventListener("pointerup", endDrag);
	canvas.addEventListener("pointercancel", endDrag);

	new ResizeObserver(() => {
		renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight), false);
		reframe();
		wake();
	}).observe(container);

	// ---- the loop ----

	let frameRequest = 0;
	let lastTick = 0;
	let lastRender = 0;
	const samples = [];

	function wake() {
		if (frameRequest) return;
		lastTick = 0;
		lastRender = 0;
		frameRequest = requestAnimationFrame(tick);
	}

	function moving() {
		return (
			!fox.settled() ||
			path.length > 0 ||
			pacing() ||
			Math.abs(wrap(yaw.target - yaw.x)) > 1e-3 ||
			Math.abs(yaw.v) > 1e-2 ||
			walk.x > 1e-3 ||
			(viewStart >= 0 && frozenBlend === null) ||
			dragging !== null
		);
	}

	function tick(now) {
		frameRequest = 0;
		if (document.hidden) return;
		const fps = moving() || fox.fast() ? FPS_FAST : FPS_SLOW;
		if (lastRender && now - lastRender < 1000 / fps - 2) {
			frameRequest = requestAnimationFrame(tick);
			return;
		}
		const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 1 / 60;
		const interval = lastRender ? now - lastRender : undefined;
		lastTick = now;
		lastRender = now;
		const started = performance.now();
		update(dt);
		renderer.render(scene, camera);
		samples.push({ at: now, work: performance.now() - started, interval });
		while (samples.length && now - samples[0].at > STATS_MS) samples.shift();
		onFrame();
		// Every state breathes and blinks, so only reduced motion lets a settled scene stop drawing.
		if (moving() || !reduced) frameRequest = requestAnimationFrame(tick);
	}

	function update(dt) {
		time += dt;
		if (!reduced) clock += dt;
		updateWalk(dt);
		updateFacing(dt);
		updateLook();
		actor.position.set(pos.x, pos.y, pos.z);
		actor.rotation.y = yaw.x;
		fox.update(dt, tempo, { amount: walk.x, phase: walk.phase });
		applyDim(fox.dim);
		updateBlend();
		applyCamera();
	}

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) wake();
	});

	const anchor = new THREE.Vector3();
	return {
		setState,
		setView,
		/** Scales how fast the fox moves and eases, 0.5 to 2. */
		setTempo(value) {
			tempo = Math.min(2, Math.max(0.5, Number(value) || 1));
			wake();
		},
		/** Holds the mouth open, 0 to 1. */
		setMouth(level) {
			fox.setMouth(level);
			wake();
		},
		/** While on, the fox's mouth forms words. */
		speak(on) {
			fox.speak(on);
			wake();
		},
		/** Freezes the view switch at `value`, 0 for 2D and 1 for 3D; `null` lets it run again. */
		setViewBlend(value) {
			frozenBlend = value === null ? null : Math.min(1, Math.max(0, Number(value)));
			wake();
		},
		/** Turns the 3D view to azimuth `az` and elevation `el` in radians, within the limits. */
		setOrbit(az, el) {
			orbit.az = clamp(az, ORBIT.az);
			orbit.el = clamp(el, ORBIT.el);
			wake();
		},
		/** Where above the fox's head a bubble points, in CSS pixels from the container's top left. */
		anchorOnScreen() {
			fox.anchor.getWorldPosition(anchor).project(camera);
			return {
				x: ((anchor.x + 1) / 2) * container.clientWidth,
				y: ((1 - anchor.y) / 2) * container.clientHeight,
			};
		},
		get state() {
			return state;
		},
		get view() {
			return viewTarget ? "3d" : "2d";
		},
		/** Whether the fox has reached its state's place and taken its pose. */
		get atPlace() {
			return posed;
		},
		/** Frames drawn in the last 2 s, with the average and worst interval between them and CPU work in each. */
		stats() {
			const now = performance.now();
			const recent = samples.filter((sample) => now - sample.at <= STATS_MS);
			const intervals = recent.map((sample) => sample.interval).filter((v) => v !== undefined);
			const works = recent.map((sample) => sample.work);
			const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
			return {
				frames: recent.length,
				intervalAvg: average(intervals),
				intervalMax: Math.max(0, ...intervals),
				workAvg: average(works),
				workMax: Math.max(0, ...works),
			};
		},
	};
}
