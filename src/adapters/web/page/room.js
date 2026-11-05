// The fox's room: a floor, a back wall with a window, two side walls and an open front, with a bed, a desk and chair,
// a plant under the window and a cushion on a rug. Units: x right, y up, z toward the viewer; the floor is y = 0.
import * as THREE from "three";
import { ellipse, flat, palette, polygon, rect, side, slab, smooth } from "./shapes.js";

export const COLORS = {
	background: "#2B1E18",
	night: "#141520",
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
	paperSide: "#B39467",
	lamp: "#FFD45C",
	lampSide: "#B8902E",
	leaf: "#4E8B4A",
	leafSide: "#2E5A2C",
	pot: "#B8553A",
	laptop: "#4A4F57",
	laptopLid: "#5C626B",
	laptopSide: "#2C2F34",
	logo: "#C9CED6",
};

export const ROOM = { x: 4, back: -3, front: 3, height: 5.5, wall: 0.3 };
const WINDOW = { x0: -0.9, x1: 0.9, y0: 2.0, y1: 3.8 };

const paint = palette();

/**
 * Builds the room. `sideWalls` each carry their own transparent materials, because the one nearer a turned camera
 * fades out; materials marked `userData.glow` keep their colour when the room dims.
 */
export function buildRoom() {
	const room = new THREE.Group();
	const { x, back, front, height, wall } = ROOM;

	room.add(flat(rect(-x - wall, -front, x + wall, -back), 0.35, paint.two(COLORS.floor, COLORS.floorSide), 0));
	for (let px = -x + 1; px < x; px += 1) {
		room.add(flat(rect(px - 0.02, -front, px + 0.02, -back), 0.01, paint(COLORS.plank), 0.01));
	}

	const backWall = rect(-x - wall, -0.35, x + wall, height);
	const hole = new THREE.Path();
	hole.moveTo(WINDOW.x0, WINDOW.y0);
	hole.lineTo(WINDOW.x1, WINDOW.y0);
	hole.lineTo(WINDOW.x1, WINDOW.y1);
	hole.lineTo(WINDOW.x0, WINDOW.y1);
	backWall.holes.push(hole);
	room.add(slab(backWall, wall, paint.two(COLORS.wall, COLORS.wallSide), back));
	room.add(buildView(back - wall));

	const sideWalls = [-1, 1].map((sign) => {
		const materials = [COLORS.sideWall, COLORS.wallSide].map(
			(color) => new THREE.MeshBasicMaterial({ color, transparent: true }),
		);
		const mesh = side(rect(back - wall, -0.35, front, height), wall, materials, sign * x);
		room.add(mesh);
		return { mesh, materials, sign };
	});

	const rug = flat(ellipse(2.1, 1.1), 0.03, paint.two(COLORS.rug, COLORS.rugSide), 0.03);
	rug.position.set(-1.0, 0, 0.9);
	room.add(rug, buildBed(), buildDesk(), buildChair(), buildCushion(), buildPlant());
	return { room, sideWalls };
}

/** The sky and a hill behind the window, and its frame and sill. */
function buildView(behind) {
	const view = new THREE.Group();
	const { x0, x1, y0, y1 } = WINDOW;
	view.add(slab(rect(x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5), 0.05, paint(COLORS.sky), behind - 0.4));
	const hill = [[x0 - 0.5, y0 - 0.5]];
	for (let i = 0; i <= 20; i++) {
		const hx = x0 - 0.5 + (i / 20) * (x1 - x0 + 1);
		hill.push([hx, y0 + 0.35 + 0.2 * Math.sin(hx * 2.3 + 1)]);
	}
	hill.push([x1 + 0.5, y0 - 0.5]);
	view.add(slab(polygon(hill), 0.05, paint(COLORS.hill), behind - 0.3));
	const frame = paint.two(COLORS.woodLight, COLORS.woodSide);
	view.add(slab(rect(-0.05, y0, 0.05, y1), 0.08, frame, ROOM.back - 0.1));
	view.add(slab(rect(x0, 2.85, x1, 2.95), 0.08, frame, ROOM.back - 0.1));
	view.add(flat(rect(x0 - 0.2, 0, x1 + 0.2, 0.35), 0.12, frame, y0).translateZ(ROOM.back + 0.35));
	return view;
}

function buildBed() {
	const bed = new THREE.Group();
	const wood = paint.two(COLORS.wood, COLORS.woodSide);
	const headboard = smooth([
		[-3.9, 0],
		[-3.9, 1.7],
		[-3.4, 2.0],
		[-2.8, 2.05],
		[-2.2, 2.0],
		[-1.7, 1.7],
		[-1.7, 0],
	]);
	bed.add(slab(new THREE.Shape(headboard), 0.15, wood, ROOM.back + 0.15));
	bed.add(slab(rect(-3.85, 0, -1.75, 0.7), 1.95, wood, -0.85));
	bed.add(flat(rect(-3.85, 0.85, -1.75, 2.75), 0.25, paint.two(COLORS.blanket, COLORS.blanketSide), 0.95));
	const pillow = flat(ellipse(0.6, 0.28), 0.18, paint.two(COLORS.paper, COLORS.paperSide), 1.12);
	pillow.position.set(-2.8, 0, -2.45);
	bed.add(pillow);
	return bed;
}

// The desk stands out from the wall, so the fox sits behind it on the chair and faces the viewer over the laptop.
function buildDesk() {
	const desk = new THREE.Group();
	const wood = paint.two(COLORS.woodLight, COLORS.woodSide);
	desk.add(flat(rect(1.7, 0.9, 3.9, 1.9), 0.12, wood, 1.05));
	for (const z of [-0.92, -1.78]) {
		for (const lx of [1.8, 3.65]) desk.add(slab(rect(lx, 0, lx + 0.15, 0.93), 0.1, wood, z));
	}
	desk.add(slab(rect(1.95, 0.45, 3.65, 0.93), 0.04, paint.two(COLORS.wood, COLORS.woodSide), -0.94));

	desk.add(flat(rect(1.95, 1.15, 2.55, 1.5), 0.04, paint.two(COLORS.laptop, COLORS.laptopSide), 1.09));
	desk.add(slab(rect(1.95, 1.09, 2.55, 1.42), 0.03, paint.two(COLORS.laptopLid, COLORS.laptopSide), -1.12));
	const logo = slab(ellipse(0.05, 0.05), 0.01, paint(COLORS.logo), -1.11);
	logo.position.set(2.25, 1.27, 0);
	desk.add(logo);

	const lamp = new THREE.Group();
	lamp.position.set(3.7, 1.05, -1.6);
	lamp.add(slab(rect(-0.04, 0, 0.04, 0.6), 0.06, paint.two(COLORS.wood, COLORS.woodSide), 0.03));
	const shade = [COLORS.lamp, COLORS.lampSide].map((color) => {
		const material = new THREE.MeshBasicMaterial({ color });
		material.userData.glow = true;
		return material;
	});
	const shadeShape = polygon([
		[-0.28, 0.5],
		[0.28, 0.5],
		[0.14, 0.82],
		[-0.14, 0.82],
	]);
	lamp.add(slab(shadeShape, 0.1, shade, 0.08));
	desk.add(lamp);
	return desk;
}

function buildChair() {
	const chair = new THREE.Group();
	const wood = paint.two(COLORS.wood, COLORS.woodSide);
	chair.add(flat(rect(2.45, 2.2, 3.25, 2.7), 0.08, wood, 0.6));
	for (const lx of [2.5, 3.1]) chair.add(slab(rect(lx, 0, lx + 0.1, 0.52), 0.08, wood, -2.25));
	chair.add(slab(rect(2.45, 0, 3.25, 1.5), 0.08, wood, -2.72));
	return chair;
}

function buildCushion() {
	const cushion = flat(ellipse(0.85, 0.5), 0.22, paint.two(COLORS.cushion, COLORS.cushionSide), 0.25);
	cushion.position.set(-1.8, 0, 1.2);
	return cushion;
}

function buildPlant() {
	const plant = new THREE.Group();
	plant.position.set(-1.25, 0, -2.55);
	const pot = polygon([
		[-0.28, 0.55],
		[0.28, 0.55],
		[0.2, 0],
		[-0.2, 0],
	]);
	plant.add(slab(pot, 0.3, paint.two(COLORS.pot, COLORS.cushionSide), 0.15));
	for (const [lx, ly, tilt] of [
		[0, 1.0, 0],
		[-0.22, 0.85, 0.6],
		[0.22, 0.85, -0.6],
	]) {
		const leaf = slab(ellipse(0.13, 0.36), 0.04, paint.two(COLORS.leaf, COLORS.leafSide), 0.02);
		leaf.position.set(lx, ly, 0);
		leaf.rotation.z = tilt;
		plant.add(leaf);
	}
	return plant;
}
