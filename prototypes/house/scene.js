// The fox's house: one room built from flat 2D shapes extruded into slabs and
// drawn unlit, like the fox. One camera blends between a fixed orthographic
// front view (2D) and a perspective view the finger turns (3D).
import * as THREE from "three";
import { COLORS, createFoxRig, ellipse, frameStats, pill, polygon } from "./fox.js";

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

	room.add(buildBed(), buildDesk(), buildCushion(), buildPlant());
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

function buildDesk() {
	const desk = new THREE.Group();
	const wood = paint2(C.woodLight, C.woodSide);
	desk.add(flat(rect(1.7, 1.65, 3.9, 2.95), 0.14, wood, 1.3));
	for (const lx of [1.8, 3.65]) desk.add(slab(rect(lx, 0, lx + 0.15, 1.16), 0.12, wood, -1.7));
	for (const lx of [1.8, 3.65]) desk.add(slab(rect(lx, 0, lx + 0.15, 1.16), 0.12, wood, -2.75));
	// A lamp and a stack of books, as cards standing on the top.
	const lamp = new THREE.Group();
	lamp.position.set(3.4, 1.3, -2.5);
	lamp.add(slab(rect(-0.04, 0, 0.04, 0.7), 0.06, paint2(C.wood, C.woodSide), 0.03));
	lamp.add(
		slab(
			polygon([
				[-0.32, 0.6],
				[0.32, 0.6],
				[0.16, 0.95],
				[-0.16, 0.95],
			]),
			0.1,
			paint2(C.lamp, "#B8902E"),
			0.08,
		),
	);
	desk.add(lamp);
	const books = [
		[C.cushion, 0.9, 0.16],
		[C.rug, 0.8, 0.14],
		[C.paper, 0.85, 0.12],
	];
	let by = 1.3;
	for (const [color, w, t] of books) {
		desk.add(slab(rect(2.0, by, 2.0 + w, by + t), 0.5, paint2(color, C.woodSide), -1.95));
		by += t;
	}
	return desk;
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

function buildBody() {
	const yb = -1.97; // the floor, in the fox's own units
	const body = new THREE.Group();
	const orange = paint2(COLORS.orange, COLORS.side);
	const shape = new THREE.Shape();
	shape.moveTo(-0.55, -0.5);
	shape.quadraticCurveTo(-0.6, -1.1, -0.95, -1.55);
	shape.quadraticCurveTo(-1.08, yb, -0.7, yb);
	shape.lineTo(0.7, yb);
	shape.quadraticCurveTo(1.08, yb, 0.95, -1.55);
	shape.quadraticCurveTo(0.6, -1.1, 0.55, -0.5);
	shape.closePath();
	body.add(slab(shape, 0.16, orange, -0.32));
	const bib = slab(ellipse(0.38, 0.6), 0.02, paint(COLORS.cream), -0.3);
	bib.position.set(0.04, -1.3, 0);
	body.add(bib);
	for (const lx of [-0.3, 0.36]) {
		const leg = slab(pill(0.72, 0.26), 0.08, orange, -0.12);
		leg.position.set(lx, yb + 0.36, 0);
		const sock = slab(pill(0.36, 0.26), 0.02, paint(COLORS.side), -0.1);
		sock.position.set(lx, yb + 0.18, 0);
		body.add(leg, sock);
	}

	// The tail curls out to the fox's right (screen left), with a cream tip.
	const tail = new THREE.Group();
	tail.position.set(-0.7, yb + 0.25, 0);
	body.add(tail);
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
	tail.add(slab(clipY(outline, 0.95, 1), 0.12, paint2(COLORS.cream, "#C9AE95"), -0.62));
	return { body, tail };
}

// ---- where each state happens ----

const FOX_SCALE = 0.5;
const FOX_FEET = 1.97;

// x, floor height, z, and which way the fox faces once there (0 = the viewer).
export const PLACES = {
	idle: { at: [-1.8, 0.25, 1.2], face: 0.2 },
	sleeping: { at: [-2.8, 0.95, -1.75], face: 0 },
	working: { at: [2.6, 0, -1.0], face: 0.3 },
	thinking: { at: [0.6, 0, 0.2], face: 0 },
	listening: { at: [0.3, 0, 1.9], face: 0 },
	talking: { at: [0.3, 0, 1.9], face: 0 },
	happy: { at: [0.3, 0, 1.9], face: 0 },
	worried: { at: [0.3, 0, 1.9], face: 0 },
};

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

	const { sideWalls } = buildRoom(scene);

	const actor = new THREE.Group();
	scene.add(actor);
	const fox = new THREE.Group();
	fox.scale.setScalar(FOX_SCALE);
	fox.position.y = FOX_FEET * FOX_SCALE;
	actor.add(fox);
	const rig = createFoxRig({ isReduced: () => reduced });
	fox.add(rig.root);
	const { body, tail } = buildBody();
	fox.add(body);

	// ---- the fox's place ----

	const place = PLACES.idle;
	actor.position.fromArray(place.at);
	let faceTarget = place.face;
	actor.rotation.y = faceTarget;
	let move = null; // { from, to, start, dur }
	let time = 0; // real seconds; moves and view switches ease even under reduced motion

	function setState(name) {
		rig.setState(name);
		const p = PLACES[name];
		const to = new THREE.Vector3().fromArray(p.at);
		const dist = actor.position.distanceTo(to);
		move = dist > 0.01 ? { from: actor.position.clone(), to, start: time, dur: 0.6 + dist * 0.32, face: p.face } : null;
		if (!move) faceTarget = p.face;
		wake();
	}

	function updateMove() {
		if (!move) return;
		const p = Math.min(1, (time - move.start) / move.dur);
		const e = ease(p);
		actor.position.lerpVectors(move.from, move.to, e);
		// A small hop when it climbs onto or off something.
		if (Math.abs(move.to.y - move.from.y) > 0.1) actor.position.y += Math.sin(p * Math.PI) * 0.45;
		const dx = move.to.x - move.from.x;
		const dz = move.to.z - move.from.z;
		// Turned toward where it goes, but never edge-on: a card seen edge-on is a line.
		faceTarget = p < 0.85 ? THREE.MathUtils.clamp(Math.atan2(dx, Math.abs(dz) + 0.5), -0.7, 0.7) : move.face;
		if (p >= 1) move = null;
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

	let clock = 0; // ambient motion; stands still under reduced motion
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

	function busy() {
		return (
			!rig.settled() ||
			move !== null ||
			Math.abs(faceTarget - actor.rotation.y) > 1e-3 ||
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
		rig.update(dt);
		updateMove();
		actor.rotation.y += (faceTarget - actor.rotation.y) * (1 - Math.exp(-dt * 8));
		if (Math.abs(faceTarget - actor.rotation.y) <= 1e-3) actor.rotation.y = faceTarget;
		tail.rotation.z = reduced ? 0 : 0.07 * Math.sin(clock * Math.PI * 2 * 0.35);
		updateBlend();
		applyCamera();
	}

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) wake();
	});

	resize();
	return {
		setState,
		setView,
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
			return rig.state;
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
		get foxAt() {
			return actor.position.toArray();
		},
		renderer,
		stats: () => frameStats(samples),
	};
}
