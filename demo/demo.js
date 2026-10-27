// liquid-glass-webgl 沙盒：多背景、预设、面板管理、调参滑杆、拖拽。
import { createLiquidGlass } from '../liquid-glass-webgl.js';

// ── 背景一：测试卡（静）——3×3 平色/图案区 + 底部光谱条，静止不动：
// 折射调试需要确定性参照物。底部光谱条用于校验边缘取色。
const TESTCARD_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
out vec4 outColor;

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / uRes;

  // ── 3×3 测试卡 + 底部光谱条 ──
  // 平色区（白/黑/灰/彩）：同色大背景上边缘可见性的四种底
  // 图案区（网格/环靶/斑马/渐变/棋盘）：折射畸变、弧度、锯齿、色散参照
  float specH = 0.04;
  float bodyY = (p.y - specH) / (1.0 - specH);   // 0..1
  int col3 = int(min(p.x * 3.0, 2.999));
  int row3 = int(min(bodyY * 3.0, 2.999));
  vec2 zf = vec2(fract(p.x * 3.0), fract(bodyY * 3.0));   // 区内归一化坐标
  vec2 zpx = zf * vec2(uRes.x / 3.0, uRes.y * (1.0 - specH) / 3.0);  // 区内像素坐标
  vec3 col;

  if (p.y < specH) {
    // 底部光谱条：色散/取色校验
    col = 0.55 + 0.45 * cos(6.2831 * (p.x + vec3(0.0, 0.33, 0.67)));
  } else if (row3 == 2) {
    // 上排
    if (col3 == 0) {
      col = vec3(1.0);                       // 纯白
    } else if (col3 == 1) {
      // 高对比网格：折射畸变参照（细 48px + 粗 240px）
      col = vec3(0.03, 0.04, 0.07);
      vec2 g = abs(fract(zpx / 48.0 - 0.5) - 0.5) * 48.0;
      float thin = smoothstep(1.1, 0.35, min(g.x, g.y));
      vec2 G = abs(fract(zpx / 240.0 - 0.5) - 0.5) * 240.0;
      float thick = smoothstep(2.4, 0.7, min(G.x, G.y));
      col = mix(col, vec3(0.90, 0.94, 1.0), thin * 0.5 + thick * 0.95);
    } else {
      // 环形靶（上半）+ 三个纯色圆（下半）：弧度与环境投影参照
      col = vec3(0.07, 0.08, 0.12);
      vec2 c1 = zpx - vec2(uRes.x / 6.0, uRes.y * 0.26);
      float r1 = length(c1);
      float rings = smoothstep(1.2, 0.3, abs(fract(r1 / 20.0) - 0.5) * 20.0)
                  * step(r1, uRes.y * 0.17);
      col = mix(col, vec3(1.0, 0.88, 0.35), rings * 0.9);
      vec3 rc[3] = vec3[3](vec3(0.95, 0.20, 0.24), vec3(0.20, 0.90, 0.45), vec3(0.25, 0.50, 0.98));
      for (int i = 0; i < 3; i++) {
        vec2 cc = vec2(uRes.x / 6.0 + (float(i) - 1.0) * uRes.y * 0.13, uRes.y * 0.12);
        float d = length(zpx - cc);
        col = mix(col, rc[i], smoothstep(uRes.y * 0.055, uRes.y * 0.052, d));
      }
    }
  } else if (row3 == 1) {
    // 中排：平色区
    if (col3 == 0) {
      col = vec3(0.0);                         // 纯黑
    } else if (col3 == 1) {
      col = vec3(0.45);                        // 中灰
    } else {
      col = vec3(0.85, 0.13, 0.16);            // 彩色平涂
    }
  } else {
    // 下排：图案区
    if (col3 == 0) {
      // 斜斑马条纹：对折线弯折的主参照
      col = mix(vec3(0.05), vec3(0.92), step(0.5, fract((zpx.x + zpx.y) / 46.0)));
    } else if (col3 == 1) {
      // 灰阶渐变：全亮度连续带，提亮/模糊对齐的观感标尺
      col = vec3(zf.x);
    } else {
      // 细棋盘：锯齿最坏情况
      vec2 q = floor(zpx / 6.0);
      col = mod(q.x + q.y, 2.0) < 0.5 ? vec3(0.08) : vec3(0.92);
    }
  }

  outColor = vec4(col, 1.0);
}`;

// ── 背景二：漂移光斑（动）——声明 uTime 的动画背景，引擎逐帧重画，
// 玻璃拖过流动色块时折射/色散/磨砂的表现最直观 ──
const BLOBS_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
out vec4 outColor;
void main() {
  vec2 q = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;   // 等比坐标，圆斑不被拉扁
  vec3 col = mix(vec3(0.07, 0.08, 0.12), vec3(0.11, 0.13, 0.19), q.y + 0.5);
  vec2 c1 = vec2(0.55 * sin(uTime * 0.31), 0.30 * cos(uTime * 0.23));
  vec2 c2 = vec2(-0.62 + 0.25 * cos(uTime * 0.19), 0.25 * sin(uTime * 0.27) - 0.10);
  vec2 c3 = vec2(0.55 + 0.20 * sin(uTime * 0.41), -0.28 + 0.18 * cos(uTime * 0.33));
  col += vec3(0.95, 0.32, 0.28) * 0.60 * exp(-3.2 * dot(q - c1, q - c1));
  col += vec3(0.25, 0.52, 0.95) * 0.60 * exp(-3.2 * dot(q - c2, q - c2));
  col += vec3(0.22, 0.85, 0.52) * 0.55 * exp(-3.6 * dot(q - c3, q - c3));
  outColor = vec4(col, 1.0);
}`;

// ── 背景三：中性灰微渐变（静）——看玻色响应最中立的底 ──
const FLAT_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
out vec4 outColor;
void main() {
  float t = gl_FragCoord.y / uRes.y;
  outColor = vec4(vec3(0.42, 0.43, 0.45) + 0.06 * t, 1.0);
}`;

const BGS = [
  ['测试卡', TESTCARD_FRAG],
  ['光斑动画', BLOBS_FRAG],
  ['纯灰', FLAT_FRAG],
];

const canvas = document.getElementById('stage');

// ── 引擎实例：换背景 = 整实例重建（bg 着色器在创建时编译定死），
// 参数与面板摆位跨重建保留 ──
let lab;
function setBg(frag) {
  const savedParams = lab ? { ...lab.params } : null;
  const savedRects = lab ? lab.rects.map((r) => ({ ...r })) : null;
  const savedNested = lab ? lab.nested : true;
  if (lab) lab.dispose();
  // nested: true = 堆叠演示玻璃压玻璃互相折射；产品默认 false（单目标叠画，更快）
  lab = createLiquidGlass(canvas, { background: frag, nested: savedNested });
  if (savedParams) {
    Object.assign(lab.params, savedParams);
    lab.rects.length = 0;
    lab.rects.push(...savedRects);
  }
  lab.start();
}
setBg(TESTCARD_FRAG);

// 首帧布局：两块玻璃错开叠一部分（演示「隔玻璃看玻璃」）
const dpr = Math.min(window.devicePixelRatio || 1, 2);
lab.rect.x = canvas.clientWidth * dpr * 0.42;
lab.rect.y = canvas.clientHeight * dpr * 0.58;
lab.rects.push({ x: canvas.clientWidth * dpr * 0.62, y: canvas.clientHeight * dpr * 0.38, w: 200, h: 200, radius: 100 });

// ── 调参滑杆定义：[key, 中文标签, min, max, step] ──
const SLIDERS = [
  ['bevel', '边缘环宽', 4, 100, 1],
  ['dist', '采样距离', 0, 120, 1],
  ['fold', '倒像陡度', 1, 4, 0.05],
  ['bend', '软弯倍率', 1, 6, 0.1],
  ['blur', '玻璃下磨砂', 0, 16, 0.5],
  ['tint', '玻色', -1, 1, 0.05],
  ['disp', '色散', 0, 4, 0.05],
  ['radius', '圆角', 0, 120, 1],
];

const panel = document.getElementById('sliders');
function syncSliders() {
  panel.querySelectorAll('input').forEach((input, i) => {
    input.value = lab.params[SLIDERS[i][0]];
    input.parentElement.querySelector('.val').textContent = String(lab.params[SLIDERS[i][0]]);
  });
}
for (const [key, label, min, max, step] of SLIDERS) {
  const row = document.createElement('label');
  row.className = 'row';
  const val = document.createElement('span');
  val.className = 'val';
  const show = () => { val.textContent = String(lab.params[key]); };
  row.innerHTML = `<span class="name">${label}</span>`;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = min; input.max = max; input.step = step;
  input.value = lab.params[key];
  input.addEventListener('input', () => {
    lab.params[key] = Number(input.value);
    show();
  });
  row.appendChild(input);
  row.appendChild(val);
  panel.appendChild(row);
  show();
}

// ── 预设：默认 + 几组常用观感（每组为完整参数快照，点击恢复全部参数，
// 含对折光带关闭——该开关仅用于定位对折线）──
const DEFAULTS = { ...lab.params };
const PRESETS = {
  '默认': DEFAULTS,
  '清透': { ...DEFAULTS, blur: 0.5, tint: 0, disp: 0.3 },
  '重磨砂': { ...DEFAULTS, blur: 16 },
  '深色玻璃': { ...DEFAULTS, blur: 8, tint: -1 },
  '强折射': { ...DEFAULTS, dist: 110, fold: 3.2, bevel: 30, blur: 1 },
  '超色散': { ...DEFAULTS, disp: 2.5, blur: 2 },
};
const presetsEl = document.getElementById('presets');
for (const [name, p] of Object.entries(PRESETS)) {
  const btn = document.createElement('button');
  btn.textContent = name;
  btn.addEventListener('click', () => {
    Object.assign(lab.params, p);
    syncSliders();
    syncToggles();
  });
  presetsEl.appendChild(btn);
}

// ── 开关：环境投影 / 嵌套折射 / 边缘反光 ──
// 边缘反光不是造型参数——它只用来点亮对折线光带（看对折线位置），做成开关，
// 所有预设固定 rim=0
const envBtn = document.createElement('button');
const nestBtn = document.createElement('button');
const rimBtn = document.createElement('button');
function syncToggles() {
  envBtn.textContent = '环境投影：' + (lab.params.envProj ? '开' : '关');
  envBtn.classList.toggle('on', !!lab.params.envProj);
  nestBtn.textContent = '嵌套折射：' + (lab.nested ? '开' : '关');
  nestBtn.classList.toggle('on', lab.nested);
  rimBtn.textContent = '对折光带：' + (lab.params.rim ? '开' : '关');
  rimBtn.classList.toggle('on', !!lab.params.rim);
}
envBtn.addEventListener('click', () => {
  lab.params.envProj = lab.params.envProj ? 0 : 1;
  syncToggles();
});
nestBtn.addEventListener('click', () => {
  lab.nested = !lab.nested;
  syncToggles();
});
rimBtn.addEventListener('click', () => {
  lab.params.rim = lab.params.rim ? 0 : 2;
  syncToggles();
});
document.getElementById('toggles').append(envBtn, nestBtn, rimBtn);
syncToggles();

// ── 背景切换 ──
const bgsEl = document.getElementById('bgs');
for (const [name, frag] of BGS) {
  const btn = document.createElement('button');
  btn.textContent = name;
  btn.addEventListener('click', () => {
    setBg(frag);
    syncBgs(name);
  });
  bgsEl.appendChild(btn);
}
function syncBgs(active) {
  bgsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.textContent === active));
}
syncBgs('测试卡');

// ── 玻璃面板管理：加方 / 加圆 / 重置两块 ──
const panelsEl = document.getElementById('panels');
function addRect(extra) {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const cx = canvas.clientWidth * d * (0.3 + Math.random() * 0.4);
  const cy = canvas.clientHeight * d * (0.3 + Math.random() * 0.4);
  lab.rects.push({ x: cx, y: cy, w: 360, h: 160, ...extra });
}
const panelBtns = [
  ['＋方玻璃', () => addRect({})],
  ['＋圆玻璃', () => addRect({ w: 200, h: 200, radius: 100 })],
  ['重置面板', () => {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    lab.rects.length = 0;
    lab.rects.push({ x: canvas.clientWidth * d * 0.42, y: canvas.clientHeight * d * 0.58, w: 360, h: 160 });
    lab.rects.push({ x: canvas.clientWidth * d * 0.62, y: canvas.clientHeight * d * 0.38, w: 200, h: 200, radius: 100 });
  }],
];
for (const [label, fn] of panelBtns) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', fn);
  panelsEl.appendChild(btn);
}

// ── 复制参数：nested 开关 + params + 面板摆位（含逐面板光学覆盖），直接粘进
// 产品代码。按钮文案的复位定时器要清旧账，防连点竞态 ──
let copyTimer = 0;
document.getElementById('copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const data = {
    nested: lab.nested,
    params: { ...lab.params },
    rects: lab.rects.map((r) => ({ ...r })),
  };
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    btn.textContent = '已复制 ✓';
  } catch {
    btn.textContent = '复制失败';
  }
  copyTimer = setTimeout(() => { btn.textContent = '复制参数'; }, 1200);
});

// ── 面板收起/展开 ──
document.getElementById('collapse').addEventListener('click', () => {
  document.body.classList.add('panel-hidden');
});
document.getElementById('fab').addEventListener('click', () => {
  document.body.classList.remove('panel-hidden');
});

// ── 拖拽移动玻璃面板（client 坐标 → gl_FragCoord 坐标：y 翻转 + dpr）。
// 命中检测取最上层的面板——数组靠后 = 堆叠在上层 ──
let dragging = null;
canvas.addEventListener('pointerdown', (e) => {
  const pt = toStage(e);
  dragging = hitPanel(pt.x, pt.y);
  if (dragging) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  // e.buttons：拖拽必须有按键/触点按住——手势被系统取消后防幽灵拖
  if (!dragging || !e.buttons) return;
  const pt = toStage(e);
  dragging.x = pt.x;
  dragging.y = pt.y;
});
canvas.addEventListener('pointerup', () => { dragging = null; });
canvas.addEventListener('pointercancel', () => { dragging = null; });
canvas.addEventListener('lostpointercapture', () => { dragging = null; });

function toStage(e) {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / r.width;
  return { x: (e.clientX - r.left) * dpr, y: (r.bottom - e.clientY) * dpr };
}

function hitPanel(x, y) {
  for (let i = lab.rects.length - 1; i >= 0; i--) {
    const r = lab.rects[i];
    if (Math.abs(x - r.x) <= r.w / 2 && Math.abs(y - r.y) <= r.h / 2) return r;
  }
  return null;
}

// FPS 显示
const fpsEl = document.getElementById('fps');
setInterval(() => { fpsEl.textContent = `${lab.fps.toFixed(0)} fps`; }, 500);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) lab.stop();
  else lab.start();
});

lab.start();
