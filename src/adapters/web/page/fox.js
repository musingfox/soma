// The fox, paper-cut: the head is one thick slab whose side walls are its dark outline, and the body, limbs and tail are
// thin cards set apart in depth, so from the side it reads like a pop-up book. In the fox's own units its neck is at
// the origin and its feet at y = -FEET.
import * as THREE from "three";
import { arcStroke, clipY, ellipse, palette, pill, polygon, slab, smooth, spring, star4 } from "./shapes.js";

export const COLORS = {
	orange: "#F47A2A",
	side: "#5A3220",
	earInner: "#3E2414",
	eye: "#1B1B1B",
	blush: "#FFB59A",
	cream: "#FDE8D3",
	creamSide: "#C9AE95",
	mouth: "#3E2414",
	tongue: "#F27C8A",
	sparkle: "#FFD45C",
	sweat: "#9AD8FF",
};

export const STATES = ["idle", "listening", "thinking", "working", "talking", "happy", "worried", "sleeping"];
export const FEET = 1.97;

// Every animated value is a channel. A state names targets, and each channel eases toward its target on a spring.
const HEAD = {
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

const HEAD_POSES = {
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
	happy: { roll: -0.04, happyEyes: 1, blush: 1.35, smile: 1, earPerk: 0.1, sparkle: 1, blink: 0 },
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

// out* turn an arm outward (negative: across the body), fwd* bring it in front of the head, curl lies the fox down,
// dim darkens the room.
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

const HEAD_OMEGA = 26;
const BODY_OMEGA = 24;
const CHANNEL_OMEGA = { dim: 10 };
const HEAD_DEPTH = 0.18;
const EYE = { x: 0.37, y: 0.07 };
const TAU = Math.PI * 2;

const paint = palette();
const orange = paint.two(COLORS.orange, COLORS.side);

/** Values that ease on springs toward the targets of a pose laid over `base`. */
function channels(base, omega) {
	const x = { ...base };
	const v = Object.fromEntries(Object.keys(base).map((key) => [key, 0]));
	let target = { ...base };
	return {
		x,
		aim(next) {
			target = { ...base, ...next };
		},
		step(dt, tempo) {
			for (const key in target) {
				[x[key], v[key]] = spring(x[key], v[key], target[key], (CHANNEL_OMEGA[key] ?? omega) * tempo, dt);
			}
		},
		settled() {
			for (const key in target) if (Math.abs(target[key] - x[key]) > 1e-3 || Math.abs(v[key]) > 1e-2) return false;
			return true;
		},
	};
}

// The head's outline, with two fur tufts on the left cheek and one on the right. The muzzle is clipped against it.
function headOutline() {
	const points = smooth(
		[
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
		],
		180,
	);
	for (const [sign, y] of [
		[-1, 0.08],
		[-1, -0.36],
		[1, 0.02],
	]) {
		let best = 0;
		points.forEach((p, i) => {
			if (Math.sign(p.x) === sign && Math.abs(p.y - y) < Math.abs(points[best].y - y)) best = i;
		});
		const middle = points[best];
		const tip = middle.clone().addScaledVector(middle.clone().normalize(), 0.1).add(new THREE.Vector2(0, -0.08));
		points.splice(best - 2, 5, tip);
	}
	return points;
}

// The muzzle's top edge from left to right: high at the cheeks, low in the middle, with a step on each side.
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

function muzzleEdgeAt(x) {
	for (let i = 1; i < MUZZLE_EDGE.length; i++) {
		const [x0, y0] = MUZZLE_EDGE[i - 1];
		const [x1, y1] = MUZZLE_EDGE[i];
		if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
	}
	return MUZZLE_EDGE[MUZZLE_EDGE.length - 1][1];
}

/** The part of the head outline below the muzzle edge. */
function muzzleShape(outline) {
	const above = (p) => p.y - muzzleEdgeAt(p.x);
	const n = outline.length;
	const below = outline.map((p) => above(p) < 0);
	const first = below.findIndex((b, i) => b && !below[(i - 1 + n) % n]);
	const run = [];
	let last = first;
	for (let i = first; below[i % n]; i++) {
		run.push(outline[i % n]);
		last = i % n;
	}
	const cross = (p, q) => p.clone().lerp(q, above(p) / (above(p) - above(q)));
	const start = cross(outline[(first - 1 + n) % n], outline[first]);
	const end = cross(outline[last], outline[(last + 1) % n]);
	const edge = MUZZLE_EDGE.filter(([x]) => x > Math.min(start.x, end.x) && x < Math.max(start.x, end.x)).map(
		([x, y]) => new THREE.Vector2(x, y),
	);
	if (end.x > start.x) edge.reverse();
	return new THREE.Shape([start, ...run, end, ...edge]);
}

function earShape(points) {
	const [[x0, y0], [cx0, cy0, x1, y1], [cx1, cy1, x2, y2]] = points;
	const shape = new THREE.Shape();
	shape.moveTo(x0, y0);
	shape.quadraticCurveTo(cx0, cy0, x1, y1);
	shape.quadraticCurveTo(cx1, cy1, x2, y2);
	shape.closePath();
	return shape;
}
const EAR = earShape([
	[0.08, 0.66],
	[0.42, 1.32, 1.0, 1.44],
	[1.1, 0.8, 0.98, 0.12],
]);
const EAR_INNER = earShape([
	[0.36, 0.62],
	[0.58, 1.1, 0.9, 1.22],
	[0.96, 0.8, 0.86, 0.4],
]);
const mirrored = (shape) => new THREE.Shape(shape.getPoints(24).map((p) => new THREE.Vector2(-p.x, p.y)));

function zGlyph() {
	return polygon([
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
	]);
}

function sweatDrop(size) {
	return polygon(
		Array.from({ length: 40 }, (_, i) => {
			const t = (i / 40) * TAU;
			return [size * 0.6 * Math.sin(t) * Math.sin(t / 2), size * Math.cos(t)];
		}),
	);
}

function buildHead() {
	const root = new THREE.Group();
	// The neck pivot sits near the bottom of the head, so the head turns and nods about it.
	const neck = new THREE.Group();
	neck.position.y = -0.55;
	root.add(neck);
	const head = new THREE.Group();
	head.position.y = 0.55;
	neck.add(head);

	const outline = headOutline();
	head.add(slab(new THREE.Shape(outline), HEAD_DEPTH, orange));

	// A hair behind the head's face, so the head covers the bottom of each dark inner ear.
	const ears = [-1, 1].map((sign) => {
		const pivot = [0.55 * sign, 0.5];
		const group = new THREE.Group();
		group.position.set(pivot[0], pivot[1], 0);
		const outer = slab(sign > 0 ? EAR : mirrored(EAR), HEAD_DEPTH, orange, -0.03, pivot);
		const inner = slab(sign > 0 ? EAR_INNER : mirrored(EAR_INNER), 0.01, paint(COLORS.earInner), -0.015, pivot);
		outer.position.set(0, 0, 0);
		inner.position.set(0, 0, 0);
		group.add(outer, inner);
		head.add(group);
		return { group, sign };
	});

	head.add(slab(muzzleShape(outline), 0.02, paint(COLORS.cream), 0.02));

	// The features shift a little toward the side the head turns to, which reads as a rounder head than the slab is.
	const face = new THREE.Group();
	head.add(face);

	const eyes = [-1, 1].map((sign) => {
		const group = new THREE.Group();
		const open = slab(pill(0.46, 0.2), 0.02, paint(COLORS.eye), 0.06);
		const happy = slab(arcStroke(0.13, 0.065, Math.PI * 0.15, Math.PI * 0.85), 0.02, paint(COLORS.eye), 0.06);
		const closed = slab(arcStroke(0.13, 0.06, Math.PI * 1.18, Math.PI * 1.82), 0.02, paint(COLORS.eye), 0.06);
		happy.position.y = -0.04;
		closed.position.y = 0.06;
		const brow = slab(pill(0.22, 0.06), 0.02, paint(COLORS.earInner), 0.07);
		brow.rotation.z = Math.PI / 2;
		const browPivot = new THREE.Group();
		browPivot.position.y = 0.29;
		browPivot.add(brow);
		group.add(open, happy, closed, browPivot);
		face.add(group);
		return { group, open, happy, closed, brow: browPivot, sign };
	});

	const blushes = [-1, 1].map((sign) => {
		const blush = slab(ellipse(0.125, 0.075), 0.02, paint(COLORS.blush), 0.04);
		blush.position.set(0.72 * sign, -0.07, 0);
		face.add(blush);
		return blush;
	});

	const mouth = new THREE.Group();
	mouth.position.y = -0.68;
	const mouthOpen = slab(ellipse(0.13, 0.12), 0.02, paint(COLORS.mouth), 0.05);
	const tongue = slab(ellipse(0.075, 0.05), 0.01, paint(COLORS.tongue), 0.06);
	tongue.position.y = -0.06;
	mouthOpen.add(tongue);
	const mouthLine = new THREE.Group();
	const line = slab(arcStroke(0.11, 0.045, Math.PI * 1.15, Math.PI * 1.85), 0.02, paint(COLORS.mouth), 0.05);
	line.position.y = 0.05;
	mouthLine.add(line);
	mouth.add(mouthOpen, mouthLine);
	face.add(mouth);

	const sweat = slab(sweatDrop(0.13), 0.02, paint(COLORS.sweat), 0.08);
	sweat.position.set(-0.86, 0.5, 0);
	head.add(sweat);

	// Effects hang off the root, so they do not turn with the head.
	const effects = new THREE.Group();
	root.add(effects);
	const dots = [
		[0.05, 0.92, 1.0],
		[0.075, 1.12, 1.22],
		[0.105, 1.36, 1.5],
	].map(([r, x, y]) => {
		const dot = slab(ellipse(r, r), 0.02, paint(COLORS.cream), 0.4);
		dot.position.set(x, y, 0);
		effects.add(dot);
		return dot;
	});
	const orbiters = [COLORS.cream, COLORS.sparkle, COLORS.cream].map((color) => {
		const orbiter = slab(ellipse(0.075, 0.075), 0.03, paint(color), 0.015);
		effects.add(orbiter);
		return orbiter;
	});
	const zs = [0, 1, 2].map(() => {
		const z = slab(zGlyph(), 0.02, new THREE.MeshBasicMaterial({ color: COLORS.cream, transparent: true }), 0.4);
		effects.add(z);
		return z;
	});
	const sparkles = [
		[-1.25, 1.1, 0.16],
		[1.3, 1.25, 0.13],
		[1.35, 0.1, 0.11],
		[-1.4, 0.0, 0.1],
	].map(([x, y, size]) => {
		const sparkle = slab(star4(1, 0.28), 0.02, paint(COLORS.sparkle), 0.4);
		sparkle.position.set(x, y, 0);
		sparkle.userData.size = size;
		effects.add(sparkle);
		return sparkle;
	});
	const waves = [0.16, 0.28].map((r) => {
		const wave = slab(arcStroke(r, 0.05, -Math.PI * 0.28, Math.PI * 0.28), 0.02, paint(COLORS.cream), 0.4);
		wave.position.set(1.12, 0.82, 0);
		effects.add(wave);
		return wave;
	});

	return {
		root,
		neck,
		face,
		ears,
		eyes,
		blushes,
		mouth: { open: mouthOpen, line: mouthLine },
		sweat,
		dots,
		orbiters,
		zs,
		sparkles,
		waves,
	};
}

/** A limb card with a slightly larger dark card behind it: orange on the orange body has no edge in a flat view. */
function limb(length, width, front, depth) {
	const group = new THREE.Group();
	const card = slab(pill(length, width), depth, orange, front);
	const back = slab(pill(length + 0.07, width + 0.07), 0.02, paint(COLORS.side), front - depth);
	card.position.y = back.position.y = -length / 2 + width / 2;
	group.add(back, card);
	return group;
}

function buildBody() {
	const feet = -FEET;
	// The torso, legs and arms squash together about the feet.
	const torso = new THREE.Group();
	torso.position.y = feet;
	const shape = new THREE.Shape();
	shape.moveTo(-0.55, -0.5);
	shape.quadraticCurveTo(-0.6, -1.1, -0.95, -1.55);
	shape.quadraticCurveTo(-1.08, feet, -0.7, feet);
	shape.lineTo(0.7, feet);
	shape.quadraticCurveTo(1.08, feet, 0.95, -1.55);
	shape.quadraticCurveTo(0.6, -1.1, 0.55, -0.5);
	shape.closePath();
	const trunk = slab(shape, 0.16, orange, -0.32);
	trunk.position.y = -feet;
	const bib = slab(ellipse(0.38, 0.6), 0.02, paint(COLORS.cream), -0.3);
	bib.position.set(0.04, -1.3 - feet, 0);
	torso.add(trunk, bib);

	const legs = [-1, 1].map((sign) => {
		const leg = limb(0.72, 0.26, -0.12, 0.08);
		const sock = slab(pill(0.36, 0.26), 0.02, paint(COLORS.side), -0.1);
		sock.position.y = -0.48;
		leg.add(sock);
		leg.position.set(sign * 0.33, -1.25 - feet, 0);
		leg.userData.sign = sign;
		torso.add(leg);
		return leg;
	});

	const arms = [-1, 1].map((sign) => {
		const arm = limb(0.52, 0.2, -0.2, 0.05);
		arm.position.set(sign * 0.4, -0.72 - feet, 0);
		arm.userData.sign = sign;
		torso.add(arm);
		return arm;
	});

	// The tail curls out to the fox's right, screen left, with a cream tip.
	const tail = new THREE.Group();
	tail.position.set(-0.7, feet + 0.25, 0);
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
	tail.add(slab(clipY(outline, 0.95, 1), 0.12, paint.two(COLORS.cream, COLORS.creamSide), -0.62));
	const outlineCard = new THREE.Shape(outline.map((p) => p.clone().multiplyScalar(1.05)));
	tail.add(slab(outlineCard, 0.02, paint(COLORS.side), -0.74));
	return { torso, legs, arms, tail };
}

/** Hides what has shrunk to nothing: a mesh scaled near zero still leaves a hairline under multisampling. */
function size(object, sx, sy = sx) {
	object.visible = Math.abs(sx) > 0.004 && Math.abs(sy) > 0.004;
	if (object.visible) object.scale.set(sx, sy, 1);
}

/**
 * A short random event on its own clock: `amount(t)` is 0 between events and runs a shape from 0 to 1 over `length`
 * seconds during one, the next one due after a pause drawn from `pause`.
 */
function every([first, firstSpread], [pause, pauseSpread], length, shape, onStart = () => {}) {
	let next = first + Math.random() * firstSpread;
	let startedAt = -1;
	return (t) => {
		if (startedAt < 0 && t >= next) {
			startedAt = t;
			onStart();
		}
		if (startedAt < 0) return 0;
		const p = (t - startedAt) / length;
		if (p < 1) return shape(p);
		startedAt = -1;
		next = t + pause + Math.random() * pauseSpread;
		return 0;
	};
}

/**
 * The fox for a scene owned by someone else. `root` stands on its feet at the origin, facing +z, `scale` scene units to
 * a fox unit. The owner picks a pose, calls `update` before each render, and keeps drawing while `settled()` is false
 * or ambient motion is on; `isReduced()` says whether ambient motion is off.
 */
export function createFox({ scale, isReduced }) {
	const head = buildHead();
	const { torso, legs, arms, tail } = buildBody();
	// root: hops and leans about the feet. body: the fox's own units, origin at the neck.
	const root = new THREE.Group();
	const body = new THREE.Group();
	body.scale.setScalar(scale);
	body.position.y = FEET * scale;
	root.add(body);
	const headMount = new THREE.Group();
	const anchor = new THREE.Object3D();
	anchor.position.y = 1.6;
	headMount.add(head.root, anchor);
	body.add(headMount, torso, tail);

	const pose = { head: channels(HEAD, HEAD_OMEGA), body: channels(BODY, BODY_OMEGA) };
	let name = "idle";
	let offsets = {};
	let mouthTarget = 0;
	let mouth = 0;
	let speaking = false;
	let t = 0;
	let tailPhase = 0;
	let twitchSign = 1;
	const blink = every([1.5, 2], [2.2, 3.5], 0.16, (p) => Math.sin(p * Math.PI));
	const twitch = every(
		[3, 4],
		[4, 6],
		0.35,
		(p) => Math.sin(p * TAU) * (1 - p),
		() => {
			twitchSign = Math.random() < 0.5 ? -1 : 1;
		},
	);

	function aim() {
		const target = { ...HEAD_POSES[name] };
		for (const key in offsets) target[key] = (target[key] ?? HEAD[key]) + offsets[key];
		pose.head.aim(target);
		pose.body.aim(BODY_POSES[name]);
	}

	// Two out-of-step waves, so the mouth opens and closes like syllables rather than like a metronome.
	const syllables = (time) => Math.max(0, 0.55 * Math.sin(time * 13) + 0.45 * Math.sin(time * 21 + 1.3) + 0.25);

	function applyHead() {
		const p = pose.head.x;
		const m = isReduced() ? 0 : 1;
		const breath = Math.sin(t * TAU * p.breatheHz);
		const parts = head;
		parts.root.position.set(m * p.tremble * Math.sin(t * 61), p.lift + m * p.bob * Math.sin(t * TAU * p.bobHz), 0);
		parts.root.position.y += m * p.talk * mouth * 0.025;
		parts.neck.scale.set(1 - m * p.breathe * 0.4 * breath, 1 + m * p.breathe * breath, 1);
		parts.neck.rotation.set(
			p.pitch,
			p.yaw + m * p.sway * Math.sin(t * TAU * p.swayHz),
			p.roll + m * p.sway * 0.3 * Math.sin(t * TAU * p.swayHz * 1.7 + 1),
		);
		parts.face.position.x = (parts.neck.rotation.y - HEAD.yaw) * 0.18 + 0.04;
		parts.face.position.y = -(parts.neck.rotation.x - HEAD.pitch) * 0.12;

		const flick = m * twitch(t) * p.twitch;
		for (const ear of parts.ears) {
			ear.group.rotation.z = ear.sign * (p.earPerk + (ear.sign === twitchSign ? flick * 0.18 : 0));
			ear.group.scale.set(1, p.earLift, 1);
		}

		const lid = 1 - m * blink(t) * p.blink;
		const shut = Math.max(p.happyEyes, p.sleepEyes);
		for (const eye of parts.eyes) {
			eye.group.position.set(EYE.x * eye.sign + p.lookX, EYE.y + p.lookY, 0);
			eye.group.rotation.z = p.eyeTilt;
			size(eye.open, p.eyeScale * (1 - shut * 0.5), p.eyeOpen * lid * (1 - shut) * p.eyeScale);
			size(eye.happy, p.happyEyes);
			size(eye.closed, p.sleepEyes);
			eye.brow.position.y = 0.29 + (eye.sign > 0 ? p.browRaise : 0) - (1 - p.eyeScale) * 0.1;
			eye.brow.rotation.z = eye.sign * -p.browTilt - p.eyeTilt;
			size(eye.brow, p.brows);
		}
		for (const blush of parts.blushes) blush.scale.set(p.blush, p.blush, 1);

		size(parts.mouth.open, p.talk * (0.75 + 0.35 * mouth), p.talk * (0.1 + 1.15 * mouth));
		size(parts.mouth.line, Math.abs(p.smile), p.smile);
		size(parts.sweat, p.sweat);
		parts.sweat.position.y = 0.5 - m * 0.06 * ((t * 0.6) % 1);

		parts.dots.forEach((dot, i) => {
			size(dot, p.dots * (0.8 + 0.2 * Math.sin(t * 5 - i * 1.1)));
		});
		parts.orbiters.forEach((orbiter, i) => {
			const a = t * 1.8 + (i * TAU) / 3 + 0.6;
			orbiter.position.set(1.35 * Math.cos(a), -0.5 - 0.42 * Math.sin(a), 0.9 * Math.sin(a));
			size(orbiter, p.orbit);
		});
		parts.zs.forEach((z, i) => {
			const q = (t * 0.22 + i / 3) % 1;
			z.position.set(0.88 + q * 0.55, 1.0 + q * 0.85, 0);
			size(z, p.zzz * (0.16 + 0.14 * q));
			z.material.opacity = Math.min(1, Math.sin(q * Math.PI) * 1.6);
		});
		parts.sparkles.forEach((sparkle, i) => {
			size(sparkle, p.sparkle * sparkle.userData.size * (0.55 + 0.45 * Math.sin(t * 4 + i * 1.7)));
			sparkle.rotation.z = m * t * 0.8 + i;
		});
		parts.waves.forEach((wave, i) => {
			size(wave, p.waves * (0.6 + 0.4 * Math.sin(t * 4 - i * 1.2)));
		});
	}

	function applyBody(walk) {
		const b = pose.body.x;
		const m = isReduced() ? 0 : 1;
		const step = Math.sin(walk.phase);
		root.position.y = m * b.hop * Math.abs(Math.sin(t * Math.PI * 1.6)) * 0.3 + walk.amount * 0.05 * Math.abs(step);
		root.rotation.x = b.lean;
		root.rotation.z = walk.amount * 0.06 * step;

		torso.scale.set(1 + 0.15 * b.curl, 1 - 0.42 * b.curl - 0.07 * b.hunch, 1);
		headMount.position.set(0.25 * b.curl, -0.78 * b.curl - 0.1 * b.hunch, 0);
		headMount.rotation.z = -0.12 * b.curl;

		const tucked = Math.max(0.001, 1 - b.curl);
		for (const leg of legs) {
			leg.rotation.z = leg.userData.sign * walk.amount * 0.5 * step;
			leg.scale.y = tucked;
			leg.visible = b.curl < 0.98;
		}
		for (const arm of arms) {
			const sign = arm.userData.sign;
			const right = sign > 0;
			const phase = right ? 0 : Math.PI;
			let out = right ? b.outR : b.outL;
			out += m * b.type * 0.12 * Math.sin(t * 11 + phase);
			out += m * b.flap * 0.3 * Math.sin(t * 9 + phase);
			if (right) out += b.gesture * 0.5 * mouth;
			out -= walk.amount * 0.35 * step * sign;
			arm.rotation.z = sign * out;
			arm.position.z = 0.3 * (right ? b.fwdR : b.fwdL);
			arm.scale.y = tucked;
			arm.visible = b.curl < 0.98;
		}

		tail.rotation.z = -2.35 * b.curl + m * b.tail * Math.sin(tailPhase);
		tail.position.z = 0.7 * b.curl;
	}

	const settled = () => pose.head.settled() && pose.body.settled() && !speaking && Math.abs(mouthTarget - mouth) < 1e-3;

	aim();
	return {
		root,
		/** Just above the ears, where a speech bubble points and typed words fly to. */
		anchor,
		/** Eases into a state's pose. */
		pose(next) {
			if (!HEAD_POSES[next]) throw new Error(`unknown state: ${next}`);
			name = next;
			aim();
		},
		/** Head values added on top of the pose's, such as a glance to the side. */
		setOffsets(next) {
			offsets = next;
			aim();
		},
		/** How open the mouth is, 0 to 1, while the fox is not speaking on its own. */
		setMouth(level) {
			mouthTarget = Math.min(1, Math.max(0, Number(level) || 0));
		},
		/** While on, the mouth moves as if forming words; off, it closes. */
		speak(on) {
			speaking = on;
			if (!on) mouthTarget = 0;
		},
		/** `walk` is how much the legs swing, 0 to 1, and where in the stride they are. */
		update(dt, tempo, walk) {
			pose.head.step(dt, tempo);
			pose.body.step(dt, tempo);
			if (!isReduced()) t += dt;
			if (speaking) mouthTarget = isReduced() ? 0.5 : Math.min(1, syllables(t));
			mouth += (mouthTarget - mouth) * (1 - Math.exp(-dt * 30));
			tailPhase += dt * TAU * pose.body.x.tailHz;
			applyHead();
			applyBody(walk);
		},
		settled,
		/** Whether the fox moves fast enough now to want 60 frames a second. */
		fast: () => !settled() || name === "talking" || name === "happy" || name === "working",
		/** How dark the room should be, 0 to 1. */
		get dim() {
			return pose.body.x.dim;
		},
	};
}
