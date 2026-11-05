// Flat 2D shapes, and the slabs extruded from them. Everything in the house is drawn unlit, so each face of a slab is
// one solid colour and its side walls read as a dark offset outline.
import * as THREE from "three";

export function polygon(points) {
	return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
}

export function rect(x0, y0, x1, y1) {
	return polygon([
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	]);
}

export function ellipse(rx, ry) {
	const shape = new THREE.Shape();
	shape.absellipse(0, 0, rx, ry, 0, Math.PI * 2, false, 0);
	return shape;
}

/** A capsule `length` tall and `width` wide, centred on the origin. */
export function pill(length, width) {
	const r = width / 2;
	const h = length / 2 - r;
	const shape = new THREE.Shape();
	shape.moveTo(-r, -h);
	shape.lineTo(-r, h);
	shape.absarc(0, h, r, Math.PI, 0, true);
	shape.lineTo(r, -h);
	shape.absarc(0, -h, r, 0, Math.PI, true);
	return shape;
}

/** A thick arc with round caps, counter-clockwise from angle `a0` to `a1`. */
export function arcStroke(radius, thickness, a0, a1) {
	const outer = radius + thickness / 2;
	const inner = radius - thickness / 2;
	const cap = thickness / 2;
	const shape = new THREE.Shape();
	shape.moveTo(outer * Math.cos(a0), outer * Math.sin(a0));
	shape.absarc(0, 0, outer, a0, a1, false);
	shape.absarc(radius * Math.cos(a1), radius * Math.sin(a1), cap, a1, a1 + Math.PI, false);
	shape.absarc(0, 0, inner, a1, a0, true);
	shape.absarc(radius * Math.cos(a0), radius * Math.sin(a0), cap, a0 + Math.PI, a0 + Math.PI * 2, false);
	return shape;
}

export function star4(outer, inner) {
	return polygon(
		Array.from({ length: 8 }, (_, i) => {
			const a = (i * Math.PI) / 4 + Math.PI / 2;
			const r = i % 2 === 0 ? outer : inner;
			return [r * Math.cos(a), r * Math.sin(a)];
		}),
	);
}

/** A closed Catmull-Rom curve through `ctrl`, as `n` points. */
export function smooth(ctrl, n = 120) {
	const curve = new THREE.CatmullRomCurve3(
		ctrl.map(([x, y]) => new THREE.Vector3(x, y, 0)),
		true,
		"centripetal",
	);
	const points = curve.getSpacedPoints(n).map((p) => new THREE.Vector2(p.x, p.y));
	points.pop();
	return points;
}

/** The part of a closed polyline above (`keep` 1) or below (`keep` -1) the line y = `cut`. */
export function clipY(points, cut, keep) {
	const inside = (p) => (p.y - cut) * keep >= 0;
	const out = [];
	points.forEach((a, i) => {
		const b = points[(i + 1) % points.length];
		if (inside(a)) out.push(a);
		if (inside(a) !== inside(b)) out.push(a.clone().lerp(b, (cut - a.y) / (b.y - a.y)));
	});
	return new THREE.Shape(out);
}

/**
 * A colour cache of unlit materials. Each part of the house keeps its own, so the room and the fox can be tinted apart
 * when the room dims.
 */
export function palette() {
	const cache = new Map();
	const paint = (color) => {
		if (!cache.has(color)) cache.set(color, new THREE.MeshBasicMaterial({ color }));
		return cache.get(color);
	};
	/** A front colour and a side colour, for a slab's faces and its walls. */
	paint.two = (front, side) => [paint(front), paint(side)];
	return paint;
}

/** Extrudes `shape` toward the back: its front face at z = `front`, `depth` deep, rotating about `pivot` if given. */
export function slab(shape, depth, material, front = 0, pivot) {
	const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 20 });
	geometry.translate(pivot ? -pivot[0] : 0, pivot ? -pivot[1] : 0, front - depth);
	const mesh = new THREE.Mesh(geometry, material);
	if (pivot) mesh.position.set(pivot[0], pivot[1], 0);
	return mesh;
}

/** Extrudes a shape drawn on the floor plane (x right, y away from the viewer) into a slab whose top is at `top`. */
export function flat(shape, thickness, material, top) {
	const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 24 });
	geometry.rotateX(-Math.PI / 2);
	geometry.translate(0, top - thickness, 0);
	return new THREE.Mesh(geometry, material);
}

/** Extrudes a shape drawn on a side plane (x toward the viewer, y up) into a wall whose inner face is at x = `inner`. */
export function side(shape, thickness, material, inner) {
	const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
	geometry.rotateY(-Math.PI / 2);
	geometry.translate(inner < 0 ? inner : inner + thickness, 0, 0);
	return new THREE.Mesh(geometry, material);
}

/**
 * One step of a critically damped spring from `x`, moving at `v`, toward `target`. It is solved exactly, so a long frame
 * cannot overshoot, and it starts from the current velocity, so a new target never kicks the motion.
 */
export function spring(x, v, target, omega, dt) {
	const d = x - target;
	const e = Math.exp(-omega * dt);
	const k = v + omega * d;
	return [target + (d + k * dt) * e, (v - omega * k * dt) * e];
}
