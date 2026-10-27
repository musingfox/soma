# House POC: milestone 1

The whole path runs end to end with stubs. This is soma M7 step 3, task card `house-poc`.

To run it, start `python3 -m http.server` in this folder and open `index.html`. three.js 0.186.1 comes from jsDelivr through the import map in `index.html`. To capture, run `node tools/capture.mjs` with `URL` set to the served page.

## Built

- **One room, as one three.js scene.** It has a floor, a back wall with a window and sky, two side walls, and an open front. Its four corners hold a bed, a desk with a lamp and books, the window with a plant under it, and a cushion on a rug. Everything is an extruded flat slab drawn with unlit flat colours, with the darker side colour showing as the offset edge (`scene.js`).
- **The fox.** The rig from `muster/den-three` (b707147) is copied to `fox.js`, with the head slab thinned to 0.18. The body, legs and tail are thin cards set apart in depth, so from the side the fox reads like a pop-up book. It is scaled to sit lower than the desk top.
- **Two views from one camera.** The 2D view is a straight-front orthographic projection. The 3D view is a perspective projection that the finger or mouse turns, within azimuth ±0.6 rad and elevation 0.15 to 0.6 rad. The switch blends the two projection matrices element by element and the camera angle, over 0.9 s with an ease-in-out. While the camera turns toward a side wall, that wall fades out, because seen from outside it would hide its half of the room. 3D frames the room 22 % looser than 2D. `window.house.setViewBlend(v)` freezes the switch at `v`, and `null` releases it.
- **The debug panel.** A gear opens it. It has 2D and 3D buttons, the eight state buttons and a frame readout (frames, interval average and worst, work average and worst, over 2 s). At 375 × 812 the page does not scroll sideways.
- **On-demand rendering.** The loop is the prototype's: 60 fps while anything eases, 30 fps for ambient motion, and nothing once settled under reduced motion. The capture measured 0 frames in 2 s for that last case.
- **`tools/capture.mjs`.** It runs headful Chromium with puppeteer-core 25.3.0 from `~/node_modules`. It records the WebGL renderer in `screenshots/measurements.json` and exits 1 on SwiftShader or on a page error. It also drags past the turn limit with real mouse input, logs the fox's path for every state, and checks the reduced-motion frame count.

## Milestone 2: the states are alive

- **Springs.** Every head pose value (`fox.js`, `spring`) and every body channel (`scene.js`, `BODY` and `BODY_POSES`) eases with a critically damped spring that starts from its current velocity, so a change mid-change never kicks. The fox's heading is a spring too. The dim is a slower spring.
- **Walking.** The fox steers a velocity toward the waypoints of a route, with capped acceleration, and lands on its spot with a spring. A new state mid-walk keeps the velocity, so the turn is a curve. Routes lead around the bed and the desk; leaving a place walks its route back out first. Legs swing and the body bobs and waddles with the distance walked. The fox faces its heading, capped at 0.7 rad off the viewer so the card never shows edge-on, and shows its back only when it walks almost straight away. Climbing onto the cushion, the bed or the chair is an arc. Under reduced motion it glides.
- **The pose waits for the arrival.** While walking, the head and body hold the idle pose; the state's pose eases in once the fox is at its place.
- **States.**
  - idle: on the cushion. It breathes and blinks, flicks its ears, and every 2.5 to 5.5 s looks to one side or back.
  - listening: front centre, facing the viewer, ears up, leaning toward the viewer.
  - thinking: paces between two points in the middle with a pause at each end, one paw at its chin.
  - working: sits on a chair behind the desk, which now stands out from the wall, facing the viewer over a laptop, paws tapping on the desk.
  - talking: front centre; the mouth follows the debug panel's mouth slider, and one arm gestures with it.
  - happy: hops, wags its tail fast, flaps its arms.
  - worried: ears down, sweat drop, hunched with its arms across its chest.
  - sleeping: curls up on the bed (body squashed, legs and arms tucked, tail wrapped in front, head lowered) while the room dims to night blue. The lamp stays lit.
- **Limbs read in the flat view** because each arm, leg and the tail has a dark card a little larger behind it.
- **Capture.** `tools/capture.mjs` now shoots all eight states in both views, the fox mid-walk, the view switch frozen at 0.5 while it walks, and checks that a retarget mid-walk moves the fox continuously. `screenshots/measurements.json` holds the paths and the checks.

## Stubs left

- Bytes loaded and frame times are not reported (M3).
- No real phone, Safari or safe-area insets were checked.
