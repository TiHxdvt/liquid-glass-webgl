# liquid-glass-webgl

A standalone WebGL2 module for rounded glass panels. A screen-space displacement field folds the sampled background at the edge. Frost, dispersion and signed tint can be set per panel. Overlapping panels can also refract the layers below them. [Gallery and Chinese guide](README.md)

## Getting started

Copy and import `liquid-glass-webgl.js`. Its JSDoc provides editor completions. TypeScript projects can read the same types with `allowJs` enabled. Give the canvas a CSS width and height.

```js
import { createLiquidGlass } from './liquid-glass-webgl.js';

const glass = createLiquidGlass(document.querySelector('canvas'), {
  background: `#version 300 es
    precision highp float;
    uniform vec2 uRes;
    out vec4 color;
    void main() { color = vec4(gl_FragCoord.xy / uRes, 0.5, 1.0); }`,
});
glass.params.blur = 3.5;
glass.params.tint = -0.5;
glass.start();
```

| Setting | Effect |
| --- | --- |
| `rects` | Panels in drawing order, bottom to top. Each has `x, y, w, h` in drawing-buffer pixels with the origin at the bottom left. Each panel may override any optical setting. |
| `radius, bevel` | Corner radius and width of the refracting edge in pixels. |
| `dist, fold, bend` | Sampling distance, falloff exponent and curvature scale of the inner fold. |
| `blur` | Gaussian standard deviation in drawing-buffer pixels, with a 0.5 px floor. The demo ranges up to 16. |
| `tint` | Dark response at −1, neutral at 0, light response at +1. |
| `disp, rim, envProj` | RGB displacement, fold highlight strength and environmental contribution to that highlight. The highlight is off by default. |
| `nested` | Refract lower panels when their sampling areas overlap. Available on opaque canvases. |
| `transparent` | Use an alpha canvas to show the underlying page outside the glass. Supply the pixels behind the glass through a shader or `setBackground`. |

## Scheduling and background updates

- `start()` detects changes to ordinary objects in `params` and `rects`, including references held by the caller. Static scenes issue no additional draw calls.
- `start({ onDemand: true })` lets static scenes sleep between events. Call `invalidate()` after editing a parameter or a panel. Background submissions, resize, pixel-ratio changes and the nested toggle wake the renderer automatically. Background shaders using `uTime` animate in either mode.
- For an external animation loop, call `stop()` and then `render(timeInMilliseconds, width, height)` whenever a frame is needed. The dimensions are optional. Automatic sizing uses the CSS content size and caps the device pixel ratio at two.
- Submit a still image once. For a video, submit decoded frames from `requestVideoFrameCallback`. For a canvas, call `setBackground(canvas)` after its pixels change. A caller-managed `version` can skip duplicate uploads of the same source. Set `preflipped: true` for an already Y-flipped source. Pass `null` to restore the background shader.
- WebGL context restoration rebuilds the GPU resources and replays the most recent readable source. Submit a fresh frame if a previously submitted bitmap or video frame has been closed. `dispose()` removes the observers and releases GPU resources.

## Tracking a DOM element

For a canvas overlay with no CSS border or padding, map the element’s client rectangle to the drawing buffer. Synchronize both elements on resize and track scroll in capture phase so scrolling containers are covered.

```js
// canvas is the overlay, element is the DOM panel, and glass is its renderer.
const panel = { x: 0, y: 0, w: 0, h: 0 };
glass.rects.splice(0, glass.rects.length, panel);
glass.start({ onDemand: true });

function layout() {
  const stage = canvas.getBoundingClientRect();
  if (!stage.width || !stage.height) return;
  const box = element.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const sx = Math.round(stage.width * dpr) / stage.width;
  const sy = Math.round(stage.height * dpr) / stage.height;
  panel.x = (box.left + box.width / 2 - stage.left) * sx;
  panel.y = (stage.bottom - box.top - box.height / 2) * sy;
  panel.w = box.width * sx;
  panel.h = box.height * sy;
  glass.invalidate();
}

const observer = new ResizeObserver(layout);
observer.observe(canvas);
observer.observe(element);
window.addEventListener('scroll', layout, true);
window.addEventListener('resize', layout);
layout();

// When unmounting:
// observer.disconnect();
// window.removeEventListener('scroll', layout, true);
// window.removeEventListener('resize', layout);
// glass.dispose();
```

Call `layout()` from the application's animation or layout callback when moving the element with a CSS transform. For browsers without WebGL2, the demo includes a CSS `backdrop-filter` fallback.

## Running the demo and regression tests

Serve the repository root with `python3 -m http.server 8000`, then open `/demo/` or `/tests/render.html`. Neither page requires a build step.
