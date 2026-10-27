// The fox, built from flat 2D shapes extruded into thin slabs and drawn unlit,
// so every face is one solid colour. The head slab's side walls are the dark
// offset silhouette of the reference; turning the head shows them.
import * as THREE from "three";

export const COLORS = {
	orange: "#F47A2A",
	side: "#5A3220",
	earInner: "#3E2414",
	eye: "#1B1B1B",
	blush: "#FFB59A",
	cream: "#FDE8D3",
	mouth: "#3E2414",
	tongue: "#F27C8A",
	sparkle: "#FFD45C",
	sweat: "#9AD8FF",
};

export const STATES = ["idle", "listening", "thinking", "working", "talking", "happy", "worried", "sleeping"];

// Every animated value is a pose parameter. A state names targets; the current
// pose eases toward them each frame, which is what animates the transitions.
const BASE = {
	yaw: 0.34,
	pitch: 0.12,
	roll: -0.12,
	lift: 0,
	breathe: 0.014,
	breatheHz: 0.25,
	bob: 0,
	bobHz: 1,
	sway: 0.05,
	swayHz: 0.09,
	hop: 0,
	tremble: 0,
	earPerk: 0,
	earLift: 1,
	twitch: 1,
	eyeOpen: 1,
	eyeScale: 1,
	eyeTilt: -0.16,
	lookX: 0,
	lookY: 0,
	happyEyes: 0,
	sleepEyes: 0,
	blink: 1,
	brows: 0,
	browTilt: 0,
	browRaise: 0,
	blush: 1,
	talk: 0,
	smile: 0,
	dots: 0,
	orbit: 0,
	zzz: 0,
	sparkle: 0,
	sweat: 0,
	waves: 0,
};

const POSES = {
	idle: {},
	listening: {
		yaw: 0.48,
		roll: 0.1,
		lift: 0.04,
		earPerk: 0.16,
		earLift: 1.12,
		eyeScale: 1.12,
		lookX: 0.04,
		sway: 0.015,
		waves: 1,
	},
	thinking: {
		yaw: 0.2,
		pitch: 0.04,
		roll: 0.16,
		lookX: 0.07,
		lookY: 0.09,
		eyeOpen: 0.9,
		brows: 1,
		browTilt: -0.12,
		browRaise: 0.07,
		sway: 0.09,
		swayHz: 0.16,
		dots: 1,
		twitch: 0,
	},
	working: {
		pitch: 0.22,
		eyeOpen: 0.6,
		lookY: -0.06,
		brows: 1,
		browTilt: -0.28,
		bob: 0.028,
		bobHz: 2.2,
		sway: 0,
		orbit: 1,
		twitch: 0,
	},
	talking: { talk: 1, bob: 0.01, bobHz: 2.4, sway: 0.04 },
	happy: {
		roll: -0.04,
		happyEyes: 1,
		blush: 1.35,
		smile: 1,
		earPerk: 0.1,
		sparkle: 1,
		blink: 0,
	},
	worried: {
		yaw: 0.2,
		pitch: 0.2,
		lift: -0.03,
		earPerk: -0.5,
		eyeScale: 0.85,
		lookY: 0.03,
		brows: 1,
		browTilt: 0.36,
		smile: -1,
		blush: 0.6,
		sweat: 1,
		tremble: 0.008,
		sway: 0.01,
		twitch: 0,
	},
	sleeping: {
		roll: -0.26,
		pitch: 0.26,
		lift: -0.06,
		breathe: 0.03,
		breatheHz: 0.18,
		sway: 0,
		earPerk: -0.3,
		sleepEyes: 1,
		blink: 0,
		blush: 0.8,
		zzz: 1,
		twitch: 0,
	},
};

// ---- 2D shapes ----

export function pill(length, width) {
	const r = width / 2;
	const h = length / 2 - r;
	const s = new THREE.Shape();
	s.moveTo(-r, -h);
	s.lineTo(-r, h);
	s.absarc(0, h, r, Math.PI, 0, true);
	s.lineTo(r, -h);
	s.absarc(0, -h, r, 0, Math.PI, true);
	return s;
}

export function ellipse(rx, ry) {
	const s = new THREE.Shape();
	s.absellipse(0, 0, rx, ry, 0, Math.PI * 2, false, 0);
	return s;
}

// A thick arc with round caps, from angle a0 to a1 counter-clockwise.
export function arcStroke(radius, thickness, a0, a1) {
	const ro = radius + thickness / 2;
	const ri = radius - thickness / 2;
	const r = thickness / 2;
	const s = new THREE.Shape();
	s.moveTo(ro * Math.cos(a0), ro * Math.sin(a0));
	s.absarc(0, 0, ro, a0, a1, false);
	s.absarc(radius * Math.cos(a1), radius * Math.sin(a1), r, a1, a1 + Math.PI, false);
	s.absarc(0, 0, ri, a1, a0, true);
	s.absarc(radius * Math.cos(a0), radius * Math.sin(a0), r, a0 + Math.PI, a0 + Math.PI * 2, false);
	return s;
}

export function polygon(points) {
	return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
}

export function star4(outer, inner) {
	const pts = [];
	for (let i = 0; i < 8; i++) {
		const a = (i * Math.PI) / 4 + Math.PI / 2;
		const r = i % 2 === 0 ? outer : inner;
		pts.push([r * Math.cos(a), r * Math.sin(a)]);
	}
	return polygon(pts);
}

function drop(size) {
	const pts = [];
	for (let i = 0; i < 40; i++) {
		const t = (i / 40) * Math.PI * 2;
		pts.push([size * 0.6 * Math.sin(t) * Math.sin(t / 2), size * Math.cos(t)]);
	}
	return polygon(pts);
}

function zGlyph(s) {
	return polygon(
		[
			[-0.5, 0.5],
			[0.5, 0.5],
			[0.5, 0.3],
			[-0.12, -0.3],
			[0.5, -0.3],
			[0.5, -0.5],
			[-0.5, -0.5],
			[-0.5, -0.3],
			[0.12, 0.3],
			[-0.5, 0.3],
		].map(([x, y]) => [x * s, y * s]),
	);
}

// The head outline as a polyline: a smooth closed curve with two fur tufts per
// cheek. The muzzle is clipped against the same polyline, so it never leaves it.
function headOutline() {
	const ctrl = [
		[0, 0.8],
		[-0.55, 0.7],
		[-0.92, 0.38],
		[-1.08, -0.05],
		[-1.02, -0.45],
		[-0.75, -0.76],
		[-0.35, -0.91],
		[0, -0.94],
		[0.35, -0.91],
		[0.75, -0.76],
		[1.02, -0.45],
		[1.08, -0.05],
		[0.92, 0.38],
		[0.55, 0.7],
	];
	const curve = new THREE.CatmullRomCurve3(
		ctrl.map(([x, y]) => new THREE.Vector3(x, y, 0)),
		true,
		"centripetal",
	);
	const pts = curve.getSpacedPoints(180).map((p) => new THREE.Vector2(p.x, p.y));
	pts.pop();
	const tufts = [
		[-1, 0.08],
		[-1, -0.36],
		[1, 0.02],
	];
	for (const [side, y] of tufts) {
		let best = 0;
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i];
			if (Math.sign(p.x) === side && Math.abs(p.y - y) < Math.abs(pts[best].y - y)) best = i;
		}
		const mid = pts[best];
		const out = mid.clone().normalize();
		const tip = mid.clone().addScaledVector(out, 0.1).add(new THREE.Vector2(0, -0.08));
		pts.splice(best - 2, 5, tip);
	}
	return pts;
}

// The muzzle's top edge, left to right: high at the cheeks, low in the middle,
// with the zig-zag steps of the reference.
const MUZZLE_EDGE = [
	[-1.4, -0.04],
	[-0.74, -0.24],
	[-0.7, -0.38],
	[-0.35, -0.53],
	[0, -0.57],
	[0.35, -0.53],
	[0.6, -0.45],
	[0.65, -0.31],
	[1.4, -0.1],
];

function edgeY(x) {
	for (let i = 1; i < MUZZLE_EDGE.length; i++) {
		const [x0, y0] = MUZZLE_EDGE[i - 1];
		const [x1, y1] = MUZZLE_EDGE[i];
		if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
	}
	return MUZZLE_EDGE[MUZZLE_EDGE.length - 1][1];
}

function muzzleShape(outline) {
	const g = (p) => p.y - edgeY(p.x);
	const n = outline.length;
	const below = outline.map((p) => g(p) < 0);
	const a = below.findIndex((b, i) => b && !below[(i - 1 + n) % n]);
	const run = [];
	let b = a;
	for (let i = a; below[i % n]; i++) {
		run.push(outline[i % n]);
		b = i % n;
	}
	const cross = (p, q) => p.clone().lerp(q, g(p) / (g(p) - g(q)));
	const start = cross(outline[(a - 1 + n) % n], outline[a]);
	const end = cross(outline[b], outline[(b + 1) % n]);
	const inner = MUZZLE_EDGE.filter(([x]) => x > Math.min(start.x, end.x) && x < Math.max(start.x, end.x)).map(
		([x, y]) => new THREE.Vector2(x, y),
	);
	if (end.x > start.x) inner.reverse();
	return new THREE.Shape([start, ...run, end, ...inner]);
}

const RIGHT_EAR = (() => {
	const s = new THREE.Shape();
	s.moveTo(0.08, 0.66);
	s.quadraticCurveTo(0.42, 1.32, 1.0, 1.44);
	s.quadraticCurveTo(1.1, 0.8, 0.98, 0.12);
	s.closePath();
	return s;
})();

const RIGHT_EAR_INNER = (() => {
	const s = new THREE.Shape();
	s.moveTo(0.36, 0.62);
	s.quadraticCurveTo(0.58, 1.1, 0.9, 1.22);
	s.quadraticCurveTo(0.96, 0.8, 0.86, 0.4);
	s.closePath();
	return s;
})();

function mirrored(shape) {
	return new THREE.Shape(shape.getPoints(24).map((p) => new THREE.Vector2(-p.x, p.y)));
}

// ---- slabs ----

const materials = new Map();
function mat(color, opts) {
	if (opts) return new THREE.MeshBasicMaterial({ color, ...opts });
	if (!materials.has(color)) materials.set(color, new THREE.MeshBasicMaterial({ color }));
	return materials.get(color);
}

// Extrudes a shape so its front face sits at z = front and it is `depth` deep.
export function slab(shape, depth, material, front = 0, pivot) {
	const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 20 });
	geo.translate(pivot ? -pivot[0] : 0, pivot ? -pivot[1] : 0, front - depth);
	const mesh = new THREE.Mesh(geo, material);
	if (pivot) mesh.position.set(pivot[0], pivot[1], 0);
	return mesh;
}

const HEAD_DEPTH = 0.18;
const EYE = { x: 0.37, y: 0.07 };

function buildFox() {
	const root = new THREE.Group();
	const neck = new THREE.Group(); // pivot for turning, near the bottom of the head
	neck.position.y = -0.55;
	root.add(neck);
	const head = new THREE.Group();
	head.position.y = 0.55;
	neck.add(head);

	const outline = headOutline();
	const headShape = new THREE.Shape(outline);
	head.add(slab(headShape, HEAD_DEPTH, [mat(COLORS.orange), mat(COLORS.side)]));

	// Ears sit a hair behind the head's face, so the head covers the bottom of
	// the dark inner ear as in the reference.
	const ears = [];
	for (const side of [-1, 1]) {
		const outer = side > 0 ? RIGHT_EAR : mirrored(RIGHT_EAR);
		const inner = side > 0 ? RIGHT_EAR_INNER : mirrored(RIGHT_EAR_INNER);
		const pivot = [0.55 * side, 0.5];
		const ear = new THREE.Group();
		ear.position.set(pivot[0], pivot[1], 0);
		const o = slab(outer, HEAD_DEPTH, [mat(COLORS.orange), mat(COLORS.side)], -0.03, pivot);
		const i = slab(inner, 0.01, mat(COLORS.earInner), -0.015, pivot);
		o.position.set(0, 0, 0);
		i.position.set(0, 0, 0);
		ear.add(o, i);
		head.add(ear);
		ears.push({ group: ear, side });
	}

	head.add(slab(muzzleShape(outline), 0.02, mat(COLORS.cream), 0.02));

	// The face features move a little toward the side the head turns to, which
	// reads as a rounder head than the flat slab really is.
	const face = new THREE.Group();
	head.add(face);

	const eyes = [];
	for (const side of [-1, 1]) {
		const g = new THREE.Group();
		g.position.set(EYE.x * side, EYE.y, 0);
		const open = slab(pill(0.46, 0.2), 0.02, mat(COLORS.eye), 0.06);
		const happy = slab(arcStroke(0.13, 0.065, Math.PI * 0.15, Math.PI * 0.85), 0.02, mat(COLORS.eye), 0.06);
		const closed = slab(arcStroke(0.13, 0.06, Math.PI * 1.18, Math.PI * 1.82), 0.02, mat(COLORS.eye), 0.06);
		happy.position.y = -0.04;
		closed.position.y = 0.06;
		const brow = slab(pill(0.22, 0.06), 0.02, mat(COLORS.earInner), 0.07);
		brow.rotation.z = Math.PI / 2;
		const browPivot = new THREE.Group();
		browPivot.position.set(0, 0.29, 0);
		browPivot.add(brow);
		g.add(open, happy, closed, browPivot);
		face.add(g);
		eyes.push({ group: g, open, happy, closed, brow: browPivot, side });
	}

	const blushes = [];
	for (const side of [-1, 1]) {
		const b = slab(ellipse(0.125, 0.075), 0.02, mat(COLORS.blush), 0.04);
		b.position.set(0.72 * side, -0.07, 0);
		face.add(b);
		blushes.push(b);
	}

	const mouth = new THREE.Group();
	mouth.position.set(0, -0.68, 0);
	const mouthOpen = slab(ellipse(0.13, 0.12), 0.02, mat(COLORS.mouth), 0.05);
	const tongue = slab(ellipse(0.075, 0.05), 0.01, mat(COLORS.tongue), 0.06);
	tongue.position.y = -0.06;
	mouthOpen.add(tongue);
	const mouthLine = slab(arcStroke(0.11, 0.045, Math.PI * 1.15, Math.PI * 1.85), 0.02, mat(COLORS.mouth), 0.05);
	mouthLine.position.y = 0.05;
	const mouthLineHolder = new THREE.Group();
	mouthLineHolder.add(mouthLine);
	mouth.add(mouthOpen, mouthLineHolder);
	face.add(mouth);

	const sweat = slab(drop(0.13), 0.02, mat(COLORS.sweat), 0.08);
	sweat.position.set(-0.86, 0.5, 0);
	head.add(sweat);

	// Effects live on the root, so they do not turn with the head.
	const fx = new THREE.Group();
	root.add(fx);
	const dots = [0.05, 0.075, 0.105].map((r) => {
		const m = slab(ellipse(r, r), 0.02, mat(COLORS.cream), 0.4);
		fx.add(m);
		return m;
	});
	dots[0].position.set(0.92, 1.0, 0);
	dots[1].position.set(1.12, 1.22, 0);
	dots[2].position.set(1.36, 1.5, 0);

	const orbiters = [COLORS.cream, COLORS.sparkle, COLORS.cream].map((c) => {
		const m = slab(ellipse(0.075, 0.075), 0.03, mat(c), 0.015);
		fx.add(m);
		return m;
	});

	const zs = [0, 1, 2].map(() => {
		const m = slab(zGlyph(1), 0.02, mat(COLORS.cream, { transparent: true }), 0.4);
		fx.add(m);
		return m;
	});

	const sparkles = [
		[-1.25, 1.1, 0.16],
		[1.3, 1.25, 0.13],
		[1.35, 0.1, 0.11],
		[-1.4, 0.0, 0.1],
	].map(([x, y, s]) => {
		const m = slab(star4(1, 0.28), 0.02, mat(COLORS.sparkle), 0.4);
		m.position.set(x, y, 0);
		m.userData.size = s;
		fx.add(m);
		return m;
	});

	const waves = [0.16, 0.28].map((r) => {
		const m = slab(arcStroke(r, 0.05, -Math.PI * 0.28, Math.PI * 0.28), 0.02, mat(COLORS.cream), 0.4);
		m.position.set(1.12, 0.82, 0);
		fx.add(m);
		return m;
	});

	return {
		root,
		neck,
		head,
		face,
		ears,
		eyes,
		blushes,
		mouth: { open: mouthOpen, line: mouthLineHolder },
		sweat,
		dots,
		orbiters,
		zs,
		sparkles,
		waves,
	};
}

// ---- the rig: pose, states and motion, without a renderer ----

/**
 * One step of a critically damped spring from `x` with velocity `v` toward
 * `target`, solved exactly so a long frame cannot overshoot. It starts from
 * the current velocity, so a new target never kicks the motion.
 */
export function spring(x, v, target, omega, dt) {
	const d = x - target;
	const e = Math.exp(-omega * dt);
	const k = v + omega * d;
	return [target + (d + k * dt) * e, (v - omega * k * dt) * e];
}

const POSE_OMEGA = 9;

/**
 * The fox's meshes and the pose logic that moves them, for a scene owned by
 * someone else. `isReduced()` says whether ambient motion is off. The owner
 * calls `update(dt)` before each render, and keeps drawing while `settled()`
 * is false or ambient motion is on.
 */
export function createFoxRig({ isReduced = () => false } = {}) {
	const fox = buildFox();

	let state = "idle";
	let target = { ...BASE };
	const pose = { ...BASE };
	const vel = Object.fromEntries(Object.keys(BASE).map((k) => [k, 0]));
	let offsets = {};
	let mouthTarget = 0;
	let mouth = 0;
	let t = 0; // motion clock; it stands still under reduced motion
	let nextBlink = 1.5 + Math.random() * 2;
	let blinkAt = -1;
	let nextTwitch = 3 + Math.random() * 4;
	let twitchAt = -1;
	let twitchSide = 1;

	function settled() {
		for (const k in target) if (Math.abs(target[k] - pose[k]) > 1e-3 || Math.abs(vel[k]) > 1e-2) return false;
		return Math.abs(mouthTarget - mouth) < 1e-3;
	}

	function fast() {
		return !settled() || state === "talking" || state === "happy" || state === "working";
	}

	function update(dt) {
		for (const key in target) [pose[key], vel[key]] = spring(pose[key], vel[key], target[key], POSE_OMEGA, dt);
		mouth += (mouthTarget - mouth) * (1 - Math.exp(-dt * 30));
		if (!isReduced()) t += dt;
		apply();
	}

	function blinkAmount() {
		if (isReduced()) return 0;
		if (blinkAt < 0 && t >= nextBlink) blinkAt = t;
		if (blinkAt < 0) return 0;
		const p = (t - blinkAt) / 0.16;
		if (p >= 1) {
			blinkAt = -1;
			nextBlink = t + 2.2 + Math.random() * 3.5;
			return 0;
		}
		return Math.sin(p * Math.PI);
	}

	function twitchAmount() {
		if (isReduced()) return 0;
		if (twitchAt < 0 && t >= nextTwitch) {
			twitchAt = t;
			twitchSide = Math.random() < 0.5 ? -1 : 1;
		}
		if (twitchAt < 0) return 0;
		const p = (t - twitchAt) / 0.35;
		if (p >= 1) {
			twitchAt = -1;
			nextTwitch = t + 4 + Math.random() * 6;
			return 0;
		}
		return Math.sin(p * Math.PI * 2) * (1 - p);
	}

	// Hides what has shrunk to nothing; a mesh scaled near zero still leaves
	// a hairline under multisampling.
	function size(obj, sx, sy = sx) {
		obj.visible = Math.abs(sx) > 0.004 && Math.abs(sy) > 0.004;
		if (obj.visible) obj.scale.set(sx, sy, 1);
	}

	function apply() {
		const p = pose;
		const m = isReduced() ? 0 : 1;
		const tau = Math.PI * 2;
		const breath = Math.sin(t * tau * p.breatheHz);

		fox.root.position.y =
			p.lift +
			m * p.bob * Math.sin(t * tau * p.bobHz) +
			m * p.hop * Math.abs(Math.sin(t * Math.PI * 1.6)) +
			m * p.talk * mouth * 0.025;
		fox.root.position.x = m * p.tremble * Math.sin(t * 61);
		fox.neck.scale.set(1 - m * p.breathe * 0.4 * breath, 1 + m * p.breathe * breath, 1);
		fox.neck.rotation.set(
			p.pitch,
			p.yaw + m * p.sway * Math.sin(t * tau * p.swayHz),
			p.roll + m * p.sway * 0.3 * Math.sin(t * tau * p.swayHz * 1.7 + 1),
		);
		fox.face.position.x = (fox.neck.rotation.y - BASE.yaw) * 0.18 + 0.04;
		fox.face.position.y = -(fox.neck.rotation.x - BASE.pitch) * 0.12;

		const tw = twitchAmount() * p.twitch;
		for (const ear of fox.ears) {
			const twitch = ear.side === twitchSide ? tw * 0.18 : 0;
			ear.group.rotation.z = ear.side * (p.earPerk + twitch);
			ear.group.scale.set(1, p.earLift, 1);
		}

		const blink = 1 - blinkAmount() * p.blink;
		const shut = Math.max(p.happyEyes, p.sleepEyes);
		for (const eye of fox.eyes) {
			eye.group.position.set(EYE.x * eye.side + p.lookX, EYE.y + p.lookY, 0);
			eye.group.rotation.z = p.eyeTilt;
			size(eye.open, p.eyeScale * (1 - shut * 0.5), p.eyeOpen * blink * (1 - shut) * p.eyeScale);
			size(eye.happy, p.happyEyes);
			size(eye.closed, p.sleepEyes);
			const raise = eye.side > 0 ? p.browRaise : 0;
			eye.brow.position.y = 0.29 + raise + (1 - p.eyeScale) * -0.1;
			eye.brow.rotation.z = eye.side * -p.browTilt - p.eyeTilt;
			size(eye.brow, p.brows);
		}
		for (const b of fox.blushes) b.scale.set(p.blush, p.blush, 1);

		const open = p.talk * (0.08 + 0.92 * mouth);
		size(fox.mouth.open, p.talk * (0.75 + 0.3 * mouth), open);
		size(fox.mouth.line, Math.abs(p.smile), p.smile);

		size(fox.sweat, p.sweat);
		fox.sweat.position.y = 0.5 - m * 0.06 * ((t * 0.6) % 1);

		fox.dots.forEach((d, i) => {
			size(d, p.dots * (0.8 + 0.2 * Math.sin(t * 5 - i * 1.1)));
		});
		fox.orbiters.forEach((o, i) => {
			const a = t * 1.8 + (i * tau) / 3 + 0.6;
			o.position.set(1.35 * Math.cos(a), -0.5 - 0.42 * Math.sin(a), 0.9 * Math.sin(a));
			size(o, p.orbit);
		});
		fox.zs.forEach((z, i) => {
			const q = (t * 0.22 + i / 3) % 1;
			z.position.set(0.88 + q * 0.55, 1.0 + q * 0.85, 0);
			size(z, p.zzz * (0.16 + 0.14 * q));
			z.material.opacity = Math.min(1, Math.sin(q * Math.PI) * 1.6);
		});
		fox.sparkles.forEach((s, i) => {
			const tw2 = 0.55 + 0.45 * Math.sin(t * 4 + i * 1.7);
			size(s, p.sparkle * s.userData.size * tw2);
			s.rotation.z = m * t * 0.8 + i;
		});
		fox.waves.forEach((w, i) => {
			const q = 0.6 + 0.4 * Math.sin(t * 4 - i * 1.2);
			size(w, p.waves * q);
		});
	}

	function setState(name) {
		if (!POSES[name]) throw new Error(`unknown state: ${name}`);
		state = name;
		retarget();
	}

	function retarget() {
		target = { ...BASE, ...POSES[state] };
		for (const k in offsets) target[k] += offsets[k];
	}

	/** Pose values added on top of the state's, such as a glance to the side. */
	function setOffsets(o) {
		offsets = o;
		retarget();
	}

	function setMouth(level) {
		mouthTarget = Math.min(1, Math.max(0, Number(level) || 0));
	}

	// Multiplies every colour of the fox by `color`, so an unlit fox can take
	// the light of the room it stands in. White gives the colours as drawn.
	function setTint(color) {
		fox.root.traverse((obj) => {
			if (!obj.material) return;
			for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
				m.userData.base ??= m.color.clone();
				m.color.copy(m.userData.base).multiply(color);
			}
		});
	}

	setState("idle");
	return {
		root: fox.root,
		update,
		settled,
		fast,
		setState,
		setMouth,
		setOffsets,
		setTint,
		get state() {
			return state;
		},
		get mouth() {
			return mouth;
		},
	};
}

const STATS_WINDOW_MS = 2000;

/** Average and worst of the frame samples `{ at, work, interval }` in the last 2 s. */
export function frameStats(samples) {
	const now = performance.now();
	const recent = samples.filter((s) => now - s.at <= STATS_WINDOW_MS);
	const intervals = recent.map((s) => s.interval).filter((v) => v !== undefined);
	const works = recent.map((s) => s.work);
	const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
	return {
		frames: recent.length,
		workAvg: avg(works),
		workMax: works.length ? Math.max(...works) : 0,
		intervalAvg: avg(intervals),
		intervalMax: intervals.length ? Math.max(...intervals) : 0,
	};
}
