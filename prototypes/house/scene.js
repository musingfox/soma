// The fox's house: one room built from flat 2D shapes extruded into slabs and
// drawn unlit, like the fox. One camera blends between a fixed orthographic
// front view (2D) and a perspective view the finger turns (3D).
import * as THREE from "three";
import { COLORS, createFoxRig, ellipse, frameStats, pill, polygon, spring } from "./fox.js";

const C = {
	bg: "#2B1E18",
	wall: "#8C5B41",
	wallSide: "#4B2E21",
	sideWall: "#7A4E37",
	floor: "#B27B50",
	floorSide: "#5E3B26",
	plank: "#9C6A45",
	wood: "#7A4A2C",
	woodSide: "#43271A",
	woodLight: "#A86B3E",
	rug: "#3F6E6A",
	rugSide: "#23403D",
	sky: "#9FD3E6",
	hill: "#6FA86A",
	blanket: "#5B8DB8",
	blanketSide: "#36597A",
	cushion: "#C8443A",
	cushionSide: "#7E2A24",
	paper: "#F4E4C4",
	lamp: "#FFD45C",
	leaf: "#4E8B4A",
	pot: "#B8553A",
};

// ---- shapes and slabs ----

function rect(x0, y0, x1, y1) {
	return polygon([
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	]);
}

const materials = new Map();
function paint(color) {
	if (!materials.has(color)) materials.set(color, new THREE.MeshBasicMaterial({ color }));
	return materials.get(color);
}
function paint2(front, side) {
	return [paint(front), paint(side)];
}

// Extrudes a shape so its front face sits at z = front and it is `depth` deep.
function slab(shape, depth, material, front = 0) {
	const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 16 });
	geo.translate(0, 0, front - depth);
	return new THREE.Mesh(geo, material);
}

// Extrudes a shape drawn in the floor plane (x right, y away from the viewer)
// into a slab whose top is at height `top`.
function flat(shape, thickness, material, top) {
	const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 24 });
	geo.rotateX(-Math.PI / 2);
	geo.translate(0, top - thickness, 0);
	return new THREE.Mesh(geo, material);
}

// Extrudes a shape drawn in the side plane (x toward the viewer, y up) into a
// wall whose inner face is at x = inner, thick toward the outside.
function side(shape, thickness, material, inner) {
	const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
	geo.rotateY(-Math.PI / 2);
	geo.translate(inner < 0 ? inner : inner + thickness, 0, 0);
	return new THREE.Mesh(geo, material);
}

// A smooth closed outline through control points, as a polyline.
function smooth(ctrl, n = 120) {
	const curve = new THREE.CatmullRomCurve3(
		ctrl.map(([x, y]) => new THREE.Vector3(x, y, 0)),
		true,
		"centripetal",
	);
	const pts = curve.getSpacedPoints(n).map((p) => new THREE.Vector2(p.x, p.y));
	pts.pop();
	return pts;
}

// The part of a closed polyline above (keep > 0) or below (keep < 0) y = cut.
function clipY(pts, cut, keep) {
	const inside = (p) => (p.y - cut) * keep >= 0;
	const out = [];
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % pts.length];
		if (inside(a)) out.push(a);
		if (inside(a) !== inside(b)) out.push(a.clone().lerp(b, (cut - a.y) / (b.y - a.y)));
	}
	return new THREE.Shape(out);
}

// ---- the room ----

const ROOM = { x: 4, back: -3, front: 3, h: 5.5, wall: 0.3 };
const WIN = { x0: -0.9, x1: 0.9, y0: 2.0, y1: 3.8 };

function buildRoom(scene) {
	const room = new THREE.Group();
	scene.add(room);
	const { x, back, front, h, wall } = ROOM;

	// Floor, with planks drawn as thin strips on top.
	room.add(flat(rect(-x - wall, -front, x + wall, -back), 0.35, paint2(C.floor, C.floorSide), 0));
	for (let px = -x + 1; px < x; px += 1) {
		room.add(flat(rect(px - 0.02, -front, px + 0.02, -back), 0.01, paint(C.plank), 0.01));
	}

	// The back wall, with the window cut through it and the sky behind.
	const backShape = rect(-x - wall, -0.35, x + wall, h);
	const hole = new THREE.Path();
	hole.moveTo(WIN.x0, WIN.y0);
	hole.lineTo(WIN.x1, WIN.y0);
	hole.lineTo(WIN.x1, WIN.y1);
	hole.lineTo(WIN.x0, WIN.y1);
	backShape.holes.push(hole);
	room.add(slab(backShape, wall, paint2(C.wall, C.wallSide), back));
	room.add(slab(rect(WIN.x0 - 0.5, WIN.y0 - 0.5, WIN.x1 + 0.5, WIN.y1 + 0.5), 0.05, paint(C.sky), back - wall - 0.4));
	const hill = [[WIN.x0 - 0.5, WIN.y0 - 0.5]];
	for (let i = 0; i <= 20; i++) {
		const hx = WIN.x0 - 0.5 + (i / 20) * (WIN.x1 - WIN.x0 + 1);
		hill.push([hx, WIN.y0 + 0.35 + 0.2 * Math.sin(hx * 2.3 + 1)]);
	}
	hill.push([WIN.x1 + 0.5, WIN.y0 - 0.5]);
	room.add(slab(polygon(hill), 0.05, paint(C.hill), back - wall - 0.3));
	const frame = paint2(C.woodLight, C.woodSide);
	room.add(slab(rect(-0.05, WIN.y0, 0.05, WIN.y1), 0.08, frame, back - 0.1));
	room.add(slab(rect(WIN.x0, 2.85, WIN.x1, 2.95), 0.08, frame, back - 0.1));
	room.add(flat(rect(WIN.x0 - 0.2, 0, WIN.x1 + 0.2, 0.35), 0.12, frame, WIN.y0).translateZ(back + 0.35));

	// Side walls, a shade darker than the back wall. Each has its own
	// materials, because the one nearer the camera fades out.
	const sideWalls = [-1, 1].map((s) => {
		const mats = [C.sideWall, C.wallSide].map((color) => new THREE.MeshBasicMaterial({ color, transparent: true }));
		const mesh = side(rect(back - wall, -0.35, front, h), wall, mats, s * x);
		room.add(mesh);
		return { mesh, mats, side: s };
	});

	// The rug in front of the cushion.
	const rug = flat(ellipse(2.1, 1.1), 0.03, paint2(C.rug, C.rugSide), 0.03);
	rug.position.set(-1.0, 0, 0.9);
	room.add(rug);

	room.add(buildBed(), buildDesk(), buildChair(), buildCushion(), buildPlant());
	return { room, sideWalls };
}

function buildBed() {
	const bed = new THREE.Group();
	const wood = paint2(C.wood, C.woodSide);
	const head = smooth([
		[-3.9, 0],
		[-3.9, 1.7],
		[-3.4, 2.0],
		[-2.8, 2.05],
		[-2.2, 2.0],
		[-1.7, 1.7],
		[-1.7, 0],
	]);
	bed.add(slab(new THREE.Shape(head), 0.15, wood, ROOM.back + 0.15));
	bed.add(slab(rect(-3.85, 0, -1.75, 0.7), 1.95, wood, -0.85));
	bed.add(flat(rect(-3.85, 0.85, -1.75, 2.75), 0.25, paint2(C.blanket, C.blanketSide), 0.95));
	const pillow = flat(ellipse(0.6, 0.28), 0.18, paint2(C.paper, "#B39467"), 1.12);
	pillow.position.set(-2.8, 0, -2.45);
	bed.add(pillow);
	return bed;
}

// The desk stands out from the wall, so the fox can sit behind it on a chair
// and face the viewer while it works.
function buildDesk() {
	const desk = new THREE.Group();
	const wood = paint2(C.woodLight, C.woodSide);
	desk.add(flat(rect(1.7, 0.9, 3.9, 1.9), 0.12, wood, 1.05));
	for (const z of [-0.92, -1.78]) {
		for (const lx of [1.8, 3.65]) desk.add(slab(rect(lx, 0, lx + 0.15, 0.93), 0.1, wood, z));
	}
	desk.add(slab(rect(1.95, 0.45, 3.65, 0.93), 0.04, paint2(C.wood, C.woodSide), -0.94));

	// A laptop to the fox's right, its lid's back to the viewer.
	desk.add(flat(rect(1.95, 1.15, 2.55, 1.5), 0.04, paint2("#4A4F57", "#2C2F34"), 1.09));
	desk.add(slab(rect(1.95, 1.09, 2.55, 1.42), 0.03, paint2("#5C626B", "#2C2F34"), -1.12));
	const logo = slab(ellipse(0.05, 0.05), 0.01, paint("#C9CED6"), -1.11);
	logo.position.set(2.25, 1.27, 0);
	desk.add(logo);

	// The lamp stays lit when the room dims.
	const lamp = new THREE.Group();
	lamp.position.set(3.7, 1.05, -1.6);
	lamp.add(slab(rect(-0.04, 0, 0.04, 0.6), 0.06, paint2(C.wood, C.woodSide), 0.03));
	const glow = [C.lamp, "#B8902E"].map((color) => {
		const m = new THREE.MeshBasicMaterial({ color });
		m.userData.glow = true;
		return m;
	});
	lamp.add(
		slab(
			polygon([
				[-0.28, 0.5],
				[0.28, 0.5],
				[0.14, 0.82],
				[-0.14, 0.82],
			]),
			0.1,
			glow,
			0.08,
		),
	);
	desk.add(lamp);
	return desk;
}

function buildChair() {
	const chair = new THREE.Group();
	const wood = paint2(C.wood, C.woodSide);
	chair.add(flat(rect(2.45, 2.2, 3.25, 2.7), 0.08, wood, 0.6));
	for (const lx of [2.5, 3.1]) chair.add(slab(rect(lx, 0, lx + 0.1, 0.52), 0.08, wood, -2.25));
	chair.add(slab(rect(2.45, 0, 3.25, 1.5), 0.08, wood, -2.72));
	return chair;
}

function buildCushion() {
	const c = flat(ellipse(0.85, 0.5), 0.22, paint2(C.cushion, C.cushionSide), 0.25);
	c.position.set(-1.8, 0, 1.2);
	return c;
}

function buildPlant() {
	const plant = new THREE.Group();
	plant.position.set(-1.25, 0, -2.55);
	plant.add(
		slab(
			polygon([
				[-0.28, 0.55],
				[0.28, 0.55],
				[0.2, 0],
				[-0.2, 0],
			]),
			0.3,
			paint2(C.pot, C.cushionSide),
			0.15,
		),
	);
	for (const [lx, ly, rot] of [
		[0, 1.0, 0],
		[-0.22, 0.85, 0.6],
		[0.22, 0.85, -0.6],
	]) {
		const leaf = slab(ellipse(0.13, 0.36), 0.04, paint2(C.leaf, "#2E5A2C"), 0.02);
		leaf.position.set(lx, ly, 0);
		leaf.rotation.z = rot;
		plant.add(leaf);
	}
	return plant;
}

// ---- the fox's body: thin cards with gaps between them, like a pop-up book ----

// The fox's own materials, apart from the room's, so the two dim differently.
const foxMaterials = new Map();
function foxPaint(color) {
	if (!foxMaterials.has(color)) foxMaterials.set(color, new THREE.MeshBasicMaterial({ color }));
	return foxMaterials.get(color);
}

// A limb card with a dark card a little bigger behind it: orange on the orange
// body has no visible edge in the flat front view without it.
function limb(length, width, front, depth) {
	const g = new THREE.Group();
	const card = slab(pill(length, width), depth, [foxPaint(COLORS.orange), foxPaint(COLORS.side)], front);
	const back = slab(pill(length + 0.07, width + 0.07), 0.02, foxPaint(COLORS.side), front - depth);
	card.position.y = back.position.y = -length / 2 + width / 2;
	g.add(back, card);
	return g;
}

function buildBody() {
	const yb = -1.97; // the floor, in the fox's own units
	const orange = [foxPaint(COLORS.orange), foxPaint(COLORS.side)];

	// Torso, legs and arms squash together about the feet.
	const torso = new THREE.Group();
	torso.position.y = yb;
	const shape = new THREE.Shape();
	shape.moveTo(-0.55, -0.5);
	shape.quadraticCurveTo(-0.6, -1.1, -0.95, -1.55);
	shape.quadraticCurveTo(-1.08, yb, -0.7, yb);
	shape.lineTo(0.7, yb);
	shape.quadraticCurveTo(1.08, yb, 0.95, -1.55);
	shape.quadraticCurveTo(0.6, -1.1, 0.55, -0.5);
	shape.closePath();
	const trunk = slab(shape, 0.16, orange, -0.32);
	trunk.position.y = -yb;
	const bib = slab(ellipse(0.38, 0.6), 0.02, foxPaint(COLORS.cream), -0.3);
	bib.position.set(0.04, -1.3 - yb, 0);
	torso.add(trunk, bib);

	const legs = [-1, 1].map((s) => {
		const leg = limb(0.72, 0.26, -0.12, 0.08);
		const sock = slab(pill(0.36, 0.26), 0.02, foxPaint(COLORS.side), -0.1);
		sock.position.y = -0.48;
		leg.add(sock);
		leg.position.set(s * 0.33, -1.25 - yb, 0);
		leg.userData.side = s;
		torso.add(leg);
		return leg;
	});

	const arms = [-1, 1].map((s) => {
		const arm = limb(0.52, 0.2, -0.2, 0.05);
		arm.position.set(s * 0.4, -0.72 - yb, 0);
		arm.userData.side = s;
		torso.add(arm);
		return arm;
	});

	// The tail curls out to the fox's right (screen left), with a cream tip.
	const tail = new THREE.Group();
	tail.position.set(-0.7, yb + 0.25, 0);
	const outline = smooth(
		[
			[0.1, -0.22],
			[-0.7, -0.28],
			[-1.25, 0.05],
			[-1.45, 0.65],
			[-1.32, 1.25],
			[-1.05, 1.55],
			[-0.95, 1.2],
			[-0.85, 0.65],
			[-0.5, 0.3],
			[0.1, 0.25],
		],
		90,
	);
	tail.add(slab(clipY(outline, 0.95, -1), 0.12, orange, -0.62));
	tail.add(slab(clipY(outline, 0.95, 1), 0.12, [foxPaint(COLORS.cream), foxPaint("#C9AE95")], -0.62));
	const tailBack = slab(
		new THREE.Shape(outline.map((p) => p.clone().multiplyScalar(1.05))),
		0.02,
		foxPaint(COLORS.side),
		-0.74,
	);
	tail.add(tailBack);
	return { torso, legs, arms, tail };
}

// ---- where each state happens, and what the body does there ----

const FOX_SCALE = 0.5;
const FOX_FEET = 1.97;

// `route` leads from the open floor to the spot, so the fox walks around the
// bed and the desk instead of through them; `face` is its yaw once there
// (0 = the viewer). Thinking paces between the two `pace` points.
export const PLACES = {
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

// Body channels per state, eased by springs like the head's pose. out* turn
// each arm outward (negative: across the body), fwd* bring it in front of the
// head, curl lies the fox down, dim darkens the room.
const BODY = {
	lean: 0,
	hunch: 0,
	curl: 0,
	outL: 0.06,
	outR: 0.06,
	fwdL: 0,
	fwdR: 0,
	tail: 0.07,
	tailHz: 0.35,
	hop: 0,
	flap: 0,
	type: 0,
	gesture: 0,
	dim: 0,
};
const BODY_POSES = {
	idle: {},
	listening: { lean: 0.16, outL: 0.18, outR: 0.18, tail: 0.04 },
	thinking: { outR: -1.15, fwdR: 1, tail: 0.04, tailHz: 0.25 },
	working: { outL: 1.2, outR: 1.2, type: 1, tail: 0.03 },
	talking: { outL: 0.12, outR: 0.3, gesture: 1, tail: 0.06, tailHz: 0.6 },
	happy: { hop: 1, outL: 0.9, outR: 0.9, flap: 1, tail: 0.28, tailHz: 2.4 },
	worried: { hunch: 1, outL: -0.55, outR: -0.55, tail: 0.02, tailHz: 0.2 },
	sleeping: { curl: 1, outL: 0, outR: 0, tail: 0, dim: 1 },
};
const BODY_OMEGA = { dim: 5 };
const BODY_OMEGA_DEFAULT = 12;

// Speeds at tempo 1. The debug panel's speed slider scales time: speeds by
// the tempo, accelerations by its square, spring rates by it.
const WALK = {
	speed: 2.3,
	pace: 1.0,
	accel: 5,
	decel: 2.8,
	stride: 0.55,
	arrive: 0.25,
	land: 10,
	turn: 11,
	legs: 14,
	pause: 0.5,
};
// Turned toward its heading, but never edge-on: a card seen edge-on is a line.
const HEADING_CAP = 0.7;
// Only a walk almost straight away shows the fox's back; a turn past side-on
// would show the card edge-on on the way.
const BACK_VIEW = 0.5;
const ROOM_NIGHT = new THREE.Color("#39406A");
const FOX_NIGHT = new THREE.Color("#8E92B8");

// ---- cameras ----

const VIEW_2D = { az: 0, el: 0.14 };
const ORBIT = { az: [-0.6, 0.6], el: [0.15, 0.6] };
// The turned room is wider on screen than the flat one, so 3D frames it looser.
const ZOOM_3D = 1.22;
const TARGET = new THREE.Vector3(0, 1.9, 0);
const FOV = THREE.MathUtils.degToRad(32);
const VIEW_SECONDS = 0.9;

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const FPS_FAST = 60;
const FPS_SLOW = 30;

/** Draws the house with the fox into `container` (sized by CSS). */
export function createHouse(container) {
	const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setClearColor(C.bg);
	renderer.domElement.style.display = "block";
	renderer.domElement.style.width = "100%";
	renderer.domElement.style.height = "100%";
	renderer.domElement.style.touchAction = "none";
	container.appendChild(renderer.domElement);

	const scene = new THREE.Scene();
	// A plain camera: its projection is set by hand from the view blend.
	const camera = new THREE.Camera();

	const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
	let reduced = reducedQuery.matches;
	reducedQuery.addEventListener("change", (e) => {
		reduced = e.matches;
		wake();
	});

	const { room, sideWalls } = buildRoom(scene);

	// actor: on the floor, turned to its heading. lean: tilts and hops about
	// the feet. fox: the fox's own units, origin at the neck.
	const actor = new THREE.Group();
	scene.add(actor);
	const lean = new THREE.Group();
	actor.add(lean);
	const fox = new THREE.Group();
	fox.scale.setScalar(FOX_SCALE);
	fox.position.y = FOX_FEET * FOX_SCALE;
	lean.add(fox);
	const rig = createFoxRig({ isReduced: () => reduced });
	const headMount = new THREE.Group();
	headMount.add(rig.root);
	fox.add(headMount);
	const { torso, legs, arms, tail } = buildBody();
	fox.add(torso, tail);

	// ---- dimming: every colour times a tint, the lamp left alone ----

	function materialsOf(group) {
		const set = new Set();
		group.traverse((o) => {
			if (!o.material) return;
			for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
				if (m.userData.glow) continue;
				m.userData.base ??= m.color.clone();
				set.add(m);
			}
		});
		return [...set];
	}
	const roomMats = materialsOf(room);
	const foxMats = materialsOf(fox);
	const tint = new THREE.Color();
	let shownDim = -1;
	function applyDim(d) {
		if (Math.abs(d - shownDim) < 1e-4) return;
		shownDim = d;
		tint.setRGB(1, 1, 1).lerp(ROOM_NIGHT, d);
		for (const m of roomMats) m.color.copy(m.userData.base).multiply(tint);
		tint.setRGB(1, 1, 1).lerp(FOX_NIGHT, d);
		for (const m of foxMats) m.color.copy(m.userData.base).multiply(tint);
		renderer.setClearColor(new THREE.Color(C.bg).lerp(new THREE.Color("#141520"), d));
	}

	// ---- the fox's state, place and walk ----

	let time = 0; // real seconds; walks and view switches ease even under reduced motion
	let clock = 0; // ambient motion; stands still under reduced motion
	let state = "idle";
	let posed = true; // the state's pose is on; it waits until the fox arrives
	const ch = {};
	for (const k in BODY) ch[k] = { x: BODY[k], v: 0, target: BODY[k] };
	function setBody(name) {
		const p = { ...BODY, ...BODY_POSES[name] };
		for (const k in ch) ch[k].target = p[k];
	}

	const start = PLACES.idle.route[0];
	const pos = { x: start[0], y: start[1], z: start[2] };
	const vel = { x: 0, z: 0 };
	let path = []; // [{ p: [x, y, z], tag: { place, idx, exit } }]
	let seg = { x: pos.x, y: pos.y, z: pos.z, len: 0 }; // where the current leg started
	let landing = false; // the last stretch: a spring onto the spot
	let zone = { place: "idle", k: 1 }; // how deep into a place's route the fox is
	let arrived = true;
	let pausedUntil = 0;
	let paceIdx = 0;
	const yaw = { x: PLACES.idle.face, v: 0, target: PLACES.idle.face };
	let walkPhase = 0;
	const walk = { x: 0, v: 0 };
	let nextLook = 3;
	let tempo = 1;
	let tailPhase = 0;

	function beginLeg() {
		const wp = path[0].p;
		seg = { x: pos.x, y: pos.y, z: pos.z, len: Math.hypot(wp[0] - pos.x, wp[2] - pos.z) };
	}

	function setState(name) {
		if (!PLACES[name]) throw new Error(`unknown state: ${name}`);
		if (name === state) return;
		state = name;
		pausedUntil = 0;
		paceIdx = 0;
		rig.setOffsets({});
		const route = PLACES[name].route;
		const here = route[route.length - 1];
		const there = Math.hypot(here[0] - pos.x, here[1] - pos.y, here[2] - pos.z);
		if (zone.place === name && there < 0.05 && !path.length) {
			pose();
			wake();
			return;
		}
		// Back out of the place the fox is in, then in along the new route.
		const exitRoute = PLACES[zone.place]?.route ?? [];
		const exit = exitRoute
			.slice(0, Math.min(zone.k, exitRoute.length - 1))
			.map((p, idx) => ({ p, tag: { place: zone.place, idx, exit: true } }))
			.reverse();
		path = [...exit, ...route.map((p, idx) => ({ p, tag: { place: name, idx, exit: false } }))];
		landing = false;
		arrived = false;
		posed = false;
		rig.setState("idle");
		setBody("idle");
		beginLeg();
		wake();
	}

	function pose() {
		posed = true;
		arrived = true;
		rig.setState(state);
		setBody(state);
	}

	function reach(wp) {
		const { place, idx, exit } = wp.tag ?? {};
		if (place) zone = { place, k: exit ? idx : idx + 1 };
	}

	function updateWalk(dt) {
		if (!path.length && state === "thinking" && posed && !reduced) {
			// Pacing: a short pause at each end, then off to the other one.
			if (!pausedUntil) pausedUntil = time + WALK.pause / tempo;
			if (time >= pausedUntil) {
				paceIdx = 1 - paceIdx;
				path = [{ p: PLACES.thinking.pace[paceIdx] }];
				landing = false;
				pausedUntil = 0;
				beginLeg();
			}
		}
		if (!path.length) return;
		const wp = path[0];
		const [tx, ty, tz] = wp.p;
		const dx = tx - pos.x;
		const dz = tz - pos.z;
		const dist = Math.hypot(dx, dz);
		const last = path.length === 1;
		const top = (!wp.tag && state === "thinking" ? WALK.pace : WALK.speed) * tempo;

		if (last && dist < WALK.arrive) landing = true;
		if (landing) {
			// The last stretch is a spring from the current velocity onto the
			// spot, so the stop eases instead of snapping.
			[pos.x, vel.x] = spring(pos.x, vel.x, tx, WALK.land * tempo, dt);
			[pos.z, vel.z] = spring(pos.z, vel.z, tz, WALK.land * tempo, dt);
		} else {
			const want = last ? Math.min(top, Math.sqrt(2 * WALK.decel * tempo * tempo * dist)) : top;
			let ax = (dx / dist) * want - vel.x;
			let az = (dz / dist) * want - vel.z;
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

		// Height follows the leg, with an arc when it climbs onto or off something.
		const left = Math.hypot(tx - pos.x, tz - pos.z);
		const u = seg.len > 1e-3 ? Math.min(1, Math.max(0, 1 - left / seg.len)) : 1;
		const climb = Math.abs(ty - seg.y) > 0.1 ? Math.sin(u * Math.PI) * 0.35 : 0;
		pos.y = seg.y + (ty - seg.y) * u + climb;

		const speed = Math.hypot(vel.x, vel.z);
		if (!last && left < 0.2) {
			reach(path.shift());
			beginLeg();
		} else if (last && left < 2e-3 && speed < 1e-2) {
			pos.x = tx;
			pos.z = tz;
			pos.y = ty;
			vel.x = vel.z = 0;
			reach(path.shift());
			landing = false;
			if (!posed) pose();
		}
	}

	function updateFacing(dt) {
		const speed = Math.hypot(vel.x, vel.z);
		if (speed > 0.12 * tempo && !landing) {
			let h = Math.atan2(vel.x, vel.z);
			const a = Math.abs(h);
			if (a > HEADING_CAP && a < Math.PI - BACK_VIEW) h = Math.sign(h) * HEADING_CAP;
			yaw.target = h;
		} else if (!path.length) {
			yaw.target = PLACES[state].face;
		}
		const goal = yaw.x + wrap(yaw.target - yaw.x);
		[yaw.x, yaw.v] = spring(yaw.x, yaw.v, goal, WALK.turn * tempo, dt);
		[walk.x, walk.v] = spring(walk.x, walk.v, reduced ? 0 : Math.min(1, speed / (0.5 * tempo)), WALK.legs * tempo, dt);
		walkPhase += (speed / WALK.stride) * Math.PI * dt;
	}

	// Idle looks around now and then.
	function updateLook() {
		if (state !== "idle" || !posed || reduced) return;
		if (clock < nextLook) return;
		const v = [-0.4, 0, 0.32, 0][Math.floor(Math.random() * 4)];
		rig.setOffsets({ yaw: v, lookX: v * 0.12 });
		nextLook = clock + 2.5 + Math.random() * 3;
	}

	function applyBody() {
		const b = Object.fromEntries(Object.entries(ch).map(([k, c]) => [k, c.x]));
		const m = reduced ? 0 : 1;
		const w = walk.x;
		const step = Math.sin(walkPhase);

		actor.position.set(pos.x, pos.y, pos.z);
		actor.rotation.y = yaw.x;
		const hop = m * b.hop * Math.abs(Math.sin(clock * Math.PI * 1.6)) * 0.3;
		lean.position.y = hop + w * 0.05 * Math.abs(step);
		lean.rotation.x = b.lean;
		lean.rotation.z = w * 0.06 * step;

		torso.scale.set(1 + 0.15 * b.curl, 1 - 0.42 * b.curl - 0.07 * b.hunch, 1);
		headMount.position.set(0.25 * b.curl, -0.78 * b.curl - 0.1 * b.hunch, 0);
		headMount.rotation.z = -0.12 * b.curl;

		for (const leg of legs) {
			leg.rotation.z = leg.userData.side * w * 0.5 * step;
			leg.scale.y = Math.max(0.001, 1 - b.curl);
			leg.visible = b.curl < 0.98;
		}
		for (const arm of arms) {
			const s = arm.userData.side;
			const right = s > 0;
			let out = right ? b.outR : b.outL;
			out += m * b.type * 0.12 * Math.sin(clock * 11 + (right ? 0 : Math.PI));
			out += m * b.flap * 0.3 * Math.sin(clock * 9 + (right ? 0 : Math.PI));
			if (right) out += b.gesture * 0.5 * rig.mouth;
			out -= w * 0.35 * step * s;
			arm.rotation.z = s * out;
			arm.position.z = 0.3 * (right ? b.fwdR : b.fwdL);
			arm.scale.y = Math.max(0.001, 1 - b.curl);
			arm.visible = b.curl < 0.98;
		}

		tail.rotation.z = -2.35 * b.curl + m * b.tail * Math.sin(tailPhase);
		tail.position.z = 0.7 * b.curl;
		applyDim(b.dim);
	}

	// ---- the view ----

	let viewTarget = 0; // 0 = 2D, 1 = 3D
	let viewFrom = 0;
	let viewStart = -1;
	let frozenBlend = null;
	let blend = 0;
	const orbit = { az: 0.35, el: 0.32 };
	let dragging = null;

	function setView(v) {
		const next = v === "3d" ? 1 : 0;
		if (next === viewTarget) return;
		viewFrom = blend;
		viewTarget = next;
		viewStart = time;
		wake();
	}

	function updateBlend() {
		if (frozenBlend !== null) {
			blend = frozenBlend;
			return;
		}
		if (viewStart < 0) {
			blend = viewTarget;
			return;
		}
		const p = Math.min(1, (time - viewStart) / (VIEW_SECONDS * Math.max(0.2, Math.abs(viewTarget - viewFrom))));
		blend = viewFrom + (viewTarget - viewFrom) * ease(p);
		if (p >= 1) viewStart = -1;
	}

	const ortho = new THREE.Matrix4();
	const persp = new THREE.Matrix4();
	const frameSize = { hw: 1, hh: 1, dist: 10 };

	function frame() {
		const w = Math.max(1, container.clientWidth);
		const h = Math.max(1, container.clientHeight);
		const aspect = w / h;
		// Show the whole room across, with a margin, and at least 5.4 units up.
		const hh = Math.max(5.4, 4.9 / aspect);
		frameSize.hh = hh;
		frameSize.hw = hh * aspect;
		frameSize.dist = hh / Math.tan(FOV / 2);
	}

	// The 2D and 3D projections agree on the plane through the target, and the
	// perspective one is scaled so its w is 1 there. Blending them element by
	// element then stays a valid projection, from orthographic to perspective.
	function applyCamera() {
		const zoom = 1 + (ZOOM_3D - 1) * blend;
		const hw = frameSize.hw * zoom;
		const hh = frameSize.hh * zoom;
		const { dist } = frameSize;
		const near = dist - 14;
		const far = dist + 14;
		ortho.makeOrthographic(-hw, hw, hh, -hh, near, far);
		const n = near;
		persp.makePerspective((-hw * n) / dist, (hw * n) / dist, (hh * n) / dist, (-hh * n) / dist, n, far);
		persp.multiplyScalar(1 / dist);
		const pe = persp.elements;
		const oe = ortho.elements;
		const me = camera.projectionMatrix.elements;
		for (let i = 0; i < 16; i++) me[i] = oe[i] + (pe[i] - oe[i]) * blend;
		camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

		const az = VIEW_2D.az + (orbit.az - VIEW_2D.az) * blend;
		const el = VIEW_2D.el + (orbit.el - VIEW_2D.el) * blend;
		camera.position.set(
			TARGET.x + dist * Math.sin(az) * Math.cos(el),
			TARGET.y + dist * Math.sin(el),
			TARGET.z + dist * Math.cos(az) * Math.cos(el),
		);
		camera.lookAt(TARGET);
		camera.updateMatrixWorld();

		// A side wall seen from outside would hide its half of the room, so the
		// wall on the camera's side fades as the view turns toward it.
		for (const w of sideWalls) {
			const opacity = 1 - THREE.MathUtils.smoothstep(Math.sin(az) * w.side, 0.03, 0.22);
			w.mesh.visible = opacity > 0.01;
			for (const m of w.mats) m.opacity = opacity;
		}
	}

	const canvas = renderer.domElement;
	canvas.addEventListener("pointerdown", (e) => {
		if (viewTarget !== 1 || frozenBlend !== null) return;
		dragging = { id: e.pointerId, x: e.clientX, y: e.clientY };
		canvas.setPointerCapture(e.pointerId);
		wake();
	});
	canvas.addEventListener("pointermove", (e) => {
		if (!dragging || e.pointerId !== dragging.id) return;
		orbit.az = clamp(orbit.az - (e.clientX - dragging.x) * 0.008, ORBIT.az);
		orbit.el = clamp(orbit.el + (e.clientY - dragging.y) * 0.006, ORBIT.el);
		dragging.x = e.clientX;
		dragging.y = e.clientY;
		wake();
	});
	const endDrag = (e) => {
		if (dragging && e.pointerId === dragging.id) dragging = null;
	};
	canvas.addEventListener("pointerup", endDrag);
	canvas.addEventListener("pointercancel", endDrag);

	function resize() {
		renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight), false);
		frame();
		wake();
	}
	const ro = new ResizeObserver(resize);
	ro.observe(container);

	// ---- the loop: draws only while something changes ----

	let raf = 0;
	let lastTick = 0;
	let lastRender = 0;
	const samples = [];

	function wake() {
		if (!raf) {
			lastTick = 0;
			lastRender = 0;
			raf = requestAnimationFrame(tick);
		}
	}

	function channelsBusy() {
		for (const k in ch) if (Math.abs(ch[k].x - ch[k].target) > 1e-3 || Math.abs(ch[k].v) > 1e-2) return true;
		return Math.abs(wrap(yaw.target - yaw.x)) > 1e-3 || Math.abs(yaw.v) > 1e-2 || walk.x > 1e-3;
	}

	const pacing = () => state === "thinking" && posed && !reduced;

	function busy() {
		return (
			!rig.settled() ||
			path.length > 0 ||
			pacing() ||
			channelsBusy() ||
			(viewStart >= 0 && frozenBlend === null) ||
			dragging !== null
		);
	}

	function tick(now) {
		raf = 0;
		if (document.hidden) return;
		const fps = busy() || rig.fast() ? FPS_FAST : FPS_SLOW;
		if (lastRender && now - lastRender < 1000 / fps - 2) {
			raf = requestAnimationFrame(tick);
			return;
		}
		const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 1 / 60;
		const interval = lastRender ? now - lastRender : undefined;
		lastTick = now;
		lastRender = now;
		const t0 = performance.now();
		update(dt);
		renderer.render(scene, camera);
		samples.push({ at: now, work: performance.now() - t0, interval });
		while (samples.length && now - samples[0].at > 2000) samples.shift();
		if (busy() || !reduced) raf = requestAnimationFrame(tick);
	}

	function update(dt) {
		time += dt;
		if (!reduced) clock += dt;
		rig.update(dt, tempo);
		updateWalk(dt);
		updateFacing(dt);
		updateLook();
		for (const k in ch) {
			const c = ch[k];
			[c.x, c.v] = spring(c.x, c.v, c.target, (BODY_OMEGA[k] ?? BODY_OMEGA_DEFAULT) * tempo, dt);
		}
		tailPhase += dt * Math.PI * 2 * ch.tailHz.x;
		applyBody();
		updateBlend();
		applyCamera();
	}

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) wake();
	});

	resize();
	applyBody();
	return {
		setState,
		setView,
		/** Scales how fast the fox moves and eases, 0.5 to 2. */
		setTempo(v) {
			tempo = Math.min(2, Math.max(0.5, Number(v) || 1));
			wake();
		},
		get tempo() {
			return tempo;
		},
		/** Sets how open the mouth is while talking, 0 to 1. */
		setMouth(level) {
			rig.setMouth(level);
			wake();
		},
		/** Freezes the view switch at `v` (0 = 2D, 1 = 3D); `null` lets it run again. */
		setViewBlend(v) {
			frozenBlend = v === null ? null : Math.min(1, Math.max(0, Number(v)));
			wake();
		},
		/** Turns the 3D view to azimuth `az` and elevation `el` (radians), within the limits. */
		setOrbit(az, el) {
			orbit.az = clamp(az, ORBIT.az);
			orbit.el = clamp(el, ORBIT.el);
			wake();
		},
		get state() {
			return state;
		},
		get view() {
			return viewTarget ? "3d" : "2d";
		},
		get blend() {
			return blend;
		},
		get orbit() {
			return { ...orbit };
		},
		get moving() {
			return busy();
		},
		/** Whether the fox has reached its state's place and taken its pose. */
		get atPlace() {
			return posed && arrived;
		},
		get foxAt() {
			return [pos.x, pos.y, pos.z];
		},
		get walking() {
			return walk.x;
		},
		get heading() {
			return yaw.x;
		},
		renderer,
		stats: () => frameStats(samples),
	};
}
