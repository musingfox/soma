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

## Stubs left

- Every state only glides the fox to its place: idle to the cushion, sleeping to the bed, working to the desk, thinking to the middle, and the other four to the front centre. The head then holds the prototype's pose for that state. There is no walk cycle and no per-state body action: the fox does not curl up, pace, or reach the desk. It hops only when it climbs onto or off the bed or cushion.
- The room does not dim for sleeping.
- There is one set of screenshots: 2D idle, 3D idle, 3D at the drag limit, mid-switch at 0.5, and the debug panel open. The full 8 × 2 set is not done.
- Bytes loaded and frame times are not reported.
