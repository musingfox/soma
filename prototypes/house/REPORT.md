# House POC

soma M7 step 3, task card `house-poc`. This is a standalone page of the fox in one room of its house, driven by a debug panel and not wired to soma. All the art is produced by code.

To run it, start `python3 -m http.server` in this folder and open `index.html`. three.js 0.186.1 comes from jsDelivr through the import map in `index.html`. To capture the evidence, serve the folder and run `node tools/capture.mjs`, with `URL` set to the page if it is not at `http://100.88.181.24:8791/index.html`. After each capture, run `biome check --write` on `screenshots/measurements.json`, or the pre-commit hook fails on its formatting.

## What is built

- **One room, one scene.** It has a floor, a back wall with a window, side walls and an open front. Its corners hold a bed, a desk with a chair, a laptop and a lamp, the window with a plant under it, and a cushion on a rug. Everything is an extruded flat slab drawn with unlit flat colours.
- **The fox is paper-cut.** The head rig comes from the den prototype (`muster/den-three`, b707147). The body, legs, arms and tail are thin cards set apart in depth.
- **Two views from one camera.** 2D is a straight-front orthographic projection. 3D is a perspective projection that the finger or mouse turns, within azimuth ±0.6 rad and elevation 0.15 to 0.6 rad. The switch blends the two projection matrices and the camera angle over 0.9 s with an ease-in-out. `window.house.setViewBlend(v)` freezes the switch at `v`.
- **Eight states, each an action at a place.**
  - idle: on the cushion. It breathes, blinks, flicks its ears and looks around.
  - listening: front centre, facing the viewer, ears up, leaning in.
  - thinking: paces in the middle with one paw at its chin.
  - working: sits behind the desk at a laptop, paws tapping.
  - talking: front centre; the mouth follows the debug panel's mouth slider.
  - happy: hops, wags its tail, flaps its arms.
  - worried: ears down, sweat drop, hunched.
  - sleeping: curled up on the bed while the room dims.
- **Walking.** The fox walks between places along routes around the bed and the desk. Its legs swing with the distance walked, and its body bobs. It turns to face its heading.
- **Every change eases.** The head pose, the body channels, the heading and the room dim are critically damped springs that start from their current velocity. A new state mid-walk keeps the walking velocity, so the fox curves round instead of snapping. The last stretch onto a spot is a spring too.
- **The debug panel.** A gear opens it. It has 2D and 3D buttons, the eight states, a speed slider (0.5× to 2×), a mouth slider and a frame readout.
- **On-demand rendering.** The loop draws at 60 fps while anything eases or moves fast (walking, pacing, working, talking, happy), and at 30 fps when only ambient motion is left. Under reduced motion it draws nothing once settled. A hidden tab draws nothing.

## Measurements

All numbers come from `screenshots/measurements.json`, written by `tools/capture.mjs` on 2026-10-27.

How they were taken:
- Chromium 155.0.8059.84 ran headful (not headless) through puppeteer-core 25.3.0, so WebGL drew on the hardware GPU. The renderer, read through `WEBGL_debug_renderer_info`, was **ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)**. The script exits 1 if the renderer is SwiftShader.
- The viewport was 375 × 812 at device pixel ratio 2, with mobile and touch emulation. The page was served by `python3 -m http.server` on the tailnet address.
- The machine was not idle: its load average was about 6 to 8 during the runs.

### Bytes loaded

The browser cache was off. Each response body was taken from the DevTools protocol; gzip is gzip -9 of that body.

| File | Raw bytes | Gzip bytes |
|---|---|---|
| `index.html` | 1,212 | 607 |
| `house.js` | 2,316 | 887 |
| `house.css` | 2,085 | 874 |
| `fox.js` | 19,688 | 6,919 |
| `scene.js` | 30,825 | 10,893 |
| **This POC's code** | **56,126** | **20,180** |
| `three.module.min.js` (jsDelivr) | 392,831 | 90,212 |
| `three.core.min.js` (jsDelivr) | 415,816 | 104,795 |
| **three.js** | **808,647** | **195,007** |
| **Page total** | **864,773** | **215,187** |

No images, fonts or models are loaded.

### Frame times

The page's own stats cover a 2 s window. "Interval" is the time between drawn frames. "Work" is the CPU time of the scene update plus the `render` call. GPU time was not measured.
- In 2D, each state was measured once the fox had reached its place and its pose had settled, then 2.2 s later.
- The walk was measured over the first 2 s of the walk from the cushion to the desk.
- The camera switch was measured over the 2 s that start with the 0.9 s switch.

| Case | Frames per 2 s | Interval avg / worst (ms) | Work avg / worst (ms) |
|---|---|---|---|
| idle, settled | 59 | 33.9 / 50.0 | 0.24 / 0.6 |
| listening, settled | 60 | 33.3 / 34.4 | 0.77 / 1.5 |
| worried, settled | 60 | 33.3 / 35.4 | 0.27 / 0.8 |
| sleeping, settled | 60 | 33.3 / 34.3 | 0.72 / 1.3 |
| working (paws tapping) | 120 | 16.7 / 17.7 | 0.65 / 1.2 |
| talking | 120 | 16.7 / 17.7 | 0.59 / 1.1 |
| happy (hopping) | 120 | 16.7 / 17.7 | 0.54 / 1.2 |
| thinking (pacing, so it walks) | 120 | 16.7 / 17.7 | 0.62 / 1.3 |
| walking, cushion to desk | 120 | 16.7 / 18.6 | 0.45 / 1.4 |
| camera switch 2D to 3D, then settled | 86 | 22.9 / 35.0 | 0.64 / 1.3 |

- The 30 and 60 fps caps held. The one 50 ms interval in idle is a single missed frame; its cause was not found.
- Per-frame CPU work stayed under 2 ms in every case.

### Zero frames

- **Reduced motion, settled:** 0 frames in 2 s. This was measured on thinking, the hardest case, because pacing stops under reduced motion.
- **Normal motion, settled:** no state ever settles without ambient motion. Every state breathes and blinks, as the card asks, so the loop keeps drawing at 30 fps or more. Measured: idle drew 59 frames in 2 s and sleeping 60. Breathing and blinks were not removed to make this case reach 0.

### Other checks in the same run

- **Drag limits.** A real mouse drag far past the limit stopped at azimuth 0.6 and elevation 0.15.
- **Retarget mid-walk.** Changing state mid-walk kept the motion continuous. The fastest movement between samples, timed by the scene's own clock, was 4.61 units/s, against a walking speed of 4.6.
- **No horizontal scroll.** With the debug panel open, `scrollWidth` was 375.

## Screenshots

These are in `screenshots/`, 375 × 812 at device pixel ratio 2, all from the run above. I looked at every one.
- Every state in both views: `2d-<state>.png` and `3d-<state>.png`. `2d-talking.png` and `3d-talking.png` have the mouth at 0.7.
- The camera mid-switch: `blend-0.5-idle.png`, and `blend-0.5-walking.png` with the fox walking.
- The fox mid-walk: `2d-walking.png`.
- The 3D view at its drag limit: `3d-drag-limit.png`.
- The debug panel open: `debug-open.png`.

## Speeds

The human chose the 2× setting, and it is baked in as the default. The speed slider scales time around it: speeds by the multiplier, accelerations by its square, and spring rates by it.

| What | Value at 1× | Where |
|---|---|---|
| Walking speed | 4.6 units/s | `scene.js`, `WALK.speed` |
| Pacing speed | 2.0 units/s | `WALK.pace` |
| Acceleration | 20 units/s² | `WALK.accel` |
| Deceleration | 11.2 units/s² | `WALK.decel` |
| Landing spring | ω 20 | `WALK.land` |
| Turning spring | ω 22 | `WALK.turn` |
| Leg-amount spring | ω 28 | `WALK.legs` |
| Pause at each end of pacing | 0.25 s | `WALK.pause` |
| Head pose spring | ω 26 | `fox.js`, `POSE_OMEGA` |
| Body channel spring | ω 24 | `scene.js`, `BODY_OMEGA_DEFAULT` |
| Room dim spring | ω 10, about 0.4 s | `BODY_OMEGA.dim` |
| Camera switch | 0.9 s | `VIEW_SECONDS` |

## Decisions the human kept

From milestone 1:
1. The side wall nearer the turned 3D camera fades out, because seen from outside it hides half the room.
2. 2D is straight-front, so props show their dark offset only on their front and bottom edges.
3. In portrait 2D, the screen above and below the room is left empty.
4. 3D frames the room 22 % looser than 2D.
5. The head slab is 0.18 thick instead of 0.32.
6. The fox hops when it climbs onto or off the bed, the cushion or the chair.

From milestone 2:
1. Working sits on a chair behind the desk, which stands out from the wall, facing the viewer over a laptop.
2. A state's pose eases in once the fox arrives; while walking it holds the idle pose.
3. Heading is capped at 0.7 rad off the viewer. The fox shows its back only when it walks almost straight away.
4. Arms are pill cards. Every limb and the tail has a dark card behind it, so it reads against the body in 2D.
5. Curling up to sleep is a squash: limbs tucked, tail wrapped in front, head lowered.
6. The dim is a night-blue tint, and the lamp stays lit.
7. Talking adds an arm gesture that follows the mouth level.
8. The happy hop moves the whole body.
9. Thinking paces between x −0.3 and 1.4 with a pause at each end.

## Not checked

- A real phone, its frame times, and its safe-area insets. Headful Chromium has none.
- Safari or WebKit.
- GPU time. The page has no timer query; only CPU work was measured.
- Pressing the buttons by hand. The script calls `window.house.setState` and `setView`, the same functions the buttons call. The drag used real mouse input.
