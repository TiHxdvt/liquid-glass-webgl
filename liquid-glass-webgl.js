// liquid-glass-webgl — 液态玻璃引擎（WebGL2 单遍着色器）
// SPDX-License-Identifier: MIT（见 LICENSE）
//
// 光学内核（教科书公式，公有领域）：
//   几何  圆角矩形解析 SDF；方向场取加宽圆角的梯度，消掉角部中轴折痕
//   折射  倒角顶面剖面 → 坡面倾角 α → 斯涅尔 β=asin(sinα/η) →
//         横向位移 = 入射点玻璃厚度 × tan(α−β)，边缘最大、向内平滑归零
//   能量  位移场导数 m′ → 采样密度 1+m′：发散压暗、汇聚提亮
//   边缘  Schlick 菲涅尔 R=R0+(1−R0)(1−cosα)⁵——边缘各边天然比背景亮一点；
//         光向角度决定朝光面再叠一层高光，哪条边更亮由光向说了算。
//         反光颜色取自玻璃周边的背景（环境反射），不是写死的白
//   色散  Cauchy 型 η(λ)，R/G/B 各算位移（蓝折得多）

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const GLASS_FRAG = `#version 300 es
precision highp float;

uniform sampler2D uBg;
uniform vec2 uRes;
uniform vec4 uRect;        // 中心 xy + 半宽高（设备像素）
uniform float uRadius;
uniform float uBevel;      // 边缘环宽 px（折叠位移场的作用范围）
uniform float uDist;       // 采样距离 px：边缘最大位移——玻璃拖入色块时「异色被拉进来」的那段距离
uniform float uFold;       // 倒像陡度：位移衰减幂次，>1 时场内出现对折点（倒像）
uniform float uBend;       // 软弯倍率：折返点曲率半径的放大系数（几何半径×倍率）
uniform float uBlur;       // 玻璃下磨砂 px（顺带抹掉位移采样的锯齿）
uniform float uDisp;       // 色散
uniform float uRim;        // 边缘反光强度
uniform float uFeather;    // 外缘羽化 px：轮廓内外颜色的过渡宽度
uniform float uEnvProj;    // 环境投影（0/1）：快靠近的元素投影到玻璃上，默认关

out vec4 outColor;

const float IOR = 1.5;
const float R0 = 0.04;     // ((η−1)/(η+1))² 正入射反射率

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 rel = frag - uRect.xy;
  float rad = min(uRadius, min(uRect.z, uRect.w) - 1.0);
  float sd = sdRoundRect(rel, uRect.zw, rad);

  // 轮廓遮罩：白档=上下边、黑档=左右边，按边缘法线角从直边到直边线性渐隐，
  // 到对方直边前归零。注意：法线必须取**真实边缘 SDF**——若取加宽 SDF 的
  // 方向场，弯角区法线偏掉，白黑两档互相染边，大圆角下整个轮廓被包住。
  const float eN = 0.6;
  vec2 nRim = normalize(vec2(
    sdRoundRect(rel + vec2(eN, 0.0), uRect.zw, rad) - sdRoundRect(rel - vec2(eN, 0.0), uRect.zw, rad),
    sdRoundRect(rel + vec2(0.0, eN), uRect.zw, rad) - sdRoundRect(rel - vec2(0.0, eN), uRect.zw, rad)) + 1e-6);
  float ang = atan(abs(nRim.x), abs(nRim.y));   // 0=上下直边，π/2=左右直边
  float maskW = 1.0 - ang / 1.5708;             // 白：弯角渐隐带
  float maskB = ang / 1.5708;                   // 黑：弯角渐隐带

  vec3 plain = texture(uBg, frag / uRes).rgb;

  // 外侧对比晕（白底黑晕、黑底白晕）。内外共用这一段，保证轮廓处连续。
  float bgLum = dot(plain, vec3(0.299, 0.587, 0.114));
  vec3 haloCol = mix(vec3(0.95), vec3(0.05), smoothstep(0.35, 0.65, bgLum));
  float halo = exp(-max(sd, 0.0) / 3.5) * 0.25 * max(maskW, maskB);
  vec3 base = mix(plain, haloCol, halo);

  // 玻璃外：底色+晕，不进折射/轮廓数学。注意：一切 exp(-depth/k) 型轮廓项
  // 必须钳在玻璃内（max(depth,0)）——玻璃外 depth<0 时指数溢出为 Inf，
  // Inf×0=NaN 会把大片画面抹黑，黑区边界沿遮罩零线走，呈直边状假投影。
  // 外缘羽化：黑白交界对比度最高，过窄出像素台阶，过宽轮廓发虚。
  float fth = max(uFeather, 0.5);
  if (sd > fth) {
    outColor = vec4(base, 1.0);
    return;
  }

  // 方向场取加宽圆角的梯度（radDir = rad + 环宽）——只消角部中轴的梯度折痕，
  // 不参与轮廓形状。注意：倒像场深度必须取**真实边缘 SDF**——它的等深轮廓是
  // 可见边缘的精确内缩（角圆心恒同一点），与边缘永远同心；若用加宽 SDF 的
  // 深度，轮廓圆心随 radDir 漂移、且先于真实半径触钳，大圆角下调到 60-80
  // 会出现边缘折线、形状冻结。
  float radDir = min(rad + uBevel, min(uRect.z, uRect.w) - 0.5);
  const float e = 0.6;
  vec2 grad = vec2(
    sdRoundRect(rel + vec2(e, 0.0), uRect.zw, radDir) - sdRoundRect(rel - vec2(e, 0.0), uRect.zw, radDir),
    sdRoundRect(rel + vec2(0.0, e), uRect.zw, radDir) - sdRoundRect(rel - vec2(0.0, e), uRect.zw, radDir));
  vec2 n2d = normalize(grad + 1e-6);   // 外
  vec2 inward = -n2d;

  float depth = -sd;                    // 真实入侵深度 px（轮廓 = 边缘同心内缩）
  float B = max(uBevel, 1.0);
  float t = clamp(depth / B, 0.0, 1.0);

  // ── 对折位移场（核心机制）──
  // 显示深度 x → 采样深度 s(x) = x + 位移。位移外缘最大（= 采样距离）、
  // 向内归零。衰减够陡时 s 在环内出现极小值（对折点）：外侧半环倒序成像
  //（倒像），对折点处条纹折返。折返顶点是二次曲率拱（曲率缩放，见下），
  // 条纹在对折线两侧弯出缓 U。注意：倒像陡度 ≤1 或 采样距离×陡度 ≤ 环宽
  // 时对折点消失，退化为纯单调映射。
  float fold = max(uFold, 1.0);
  // 端点软化 w²/(w+ε)：裸幂 (1−t)^fold 在环内界 (t=1) 处二阶导发散
  //（fold<2 时），界面留下可见接缝；w≫ε 处与 w 几乎一致，w→0 时 ~w²，
  // 整场以 C² 接入平面玻璃区。ε 取亚像素。
  float eps = 0.004;
  float w = max(1.0 - t, 0.0);
  float wr = w * w / (w + eps);
  float sRaw = depth + uDist * pow(wr, fold);
  // d(wr)/dw = w(w+2ε)/(w+ε)² —— 顺手带上，斜率解析可读
  float wrSlope = w * (w + 2.0 * eps) / ((w + eps) * (w + eps));
  float sRawPrime = 1.0 - uDist * fold * pow(max(wr, 1e-5), fold - 1.0) * wrSlope / B;

  // 对折点（s′=0）：极小采样深度 sMin，位置 t0
  float t0 = 1.0 - pow(clamp(B / max(uDist * fold, 1e-3), 0.0, 1.0), 1.0 / max(fold - 1.0, 1e-3));
  t0 = clamp(t0, 0.0, 1.0);
  float sMin = t0 * B + uDist * pow(max(1.0 - t0, 0.0), fold);
  float d0 = t0 * B;                  // 折线深度（离玻璃缘）

  // ── 外侧臂（玻璃缘 → 折线）：四分之一椭圆弧 ──
  // 剖面取椭圆的四分之一：从折线处的水平切线平滑转到玻璃缘的竖直切线，
  // 整臂转满 90°。幂次剖面是「半条抛物线」（曲率越走越小），弧度不足。
  // 边界条件定形：v 半轴 = uDist−sMin（缘=采样距离、顶=极小值），
  // u 半轴 = 折线深度（默认参数下两轴 ≈1:2）。内外曲率不一致，顶点一阶
  // 连续会师。
  float V = max(uDist - sMin, 0.5);
  float du0 = max(d0, 1e-3);
  float ue = clamp((d0 - depth) / du0, 0.0, 1.0);
  float ue2 = min(ue * ue, 0.999);
  float sOuter = sMin + V * (1.0 - sqrt(1.0 - ue2));
  float sOuterPrime = -V * ue / (du0 * sqrt(1.0 - ue2));   // 负：外侧倒序

  // ── 内侧臂（折线 → 玻璃中心）：曲率缩放（不是磨圆！）──
  // g(x) = x·(a + (1−a)·tanh(x/bend))，a = 1/k。g′(0)=a > 0 → 顶点保持
  // 二次曲率（全程在弯）。注意：不能用磨圆式软化（g′(0)=0，如 x·tanh）——
  // 顶点会被拉成四次平顶，表现为对折线变宽、顶点下图像被拉直、两侧隔着
  // 平顶不衔接。远场 tanh → 1 指数收敛。
  float k = max(clamp(uBend, 0.0, 10.0), 1.0);   // 软弯倍率（只作用于内臂）
  float a = 1.0 / k;
  float bend = max(B * (1.0 - t0) / max(fold - 1.0, 1e-3) * k, 0.5);
  float x = sRaw - sMin;
  float ug = x / bend;
  float th = tanh(ug);
  float sInner = sMin + x * (a + (1.0 - a) * th);
  float soften = a + (1.0 - a) * (th + ug * (1.0 - th * th));
  float sInnerPrime = sRawPrime * soften;

  // 外侧用椭圆弧、内侧用曲率缩放——顶点处两侧都是水平切线，C¹ 会师
  float sMap = depth < d0 ? sOuter : sInner;
  float sPrime = depth < d0 ? sOuterPrime : sInnerPrime;
  float shift = sMap - depth;

  // 三通道折射率（Cauchy 色散倾向：短波折得多）
  float disp = uDisp * 0.02;
  vec2 spR = frag + inward * shift * (1.0 - disp);
  vec2 spG = frag + inward * shift;
  vec2 spB = frag + inward * shift * (1.0 + disp);

  // 玻璃下微磨砂。模糊度对齐玻璃中部：位移映射的放大区（|s′|<1，对折线两侧
  // 在此列）会把采样拉伸显糊——按 |s′| 补偿性锐化拉回；压缩区不再额外加糊。
  float lod = log2(max(uBlur, 0.5) + 1.0) + min(0.0, log2(max(abs(sPrime), 0.2)));
  vec3 col = vec3(
    textureLod(uBg, spR / uRes, lod).r,
    textureLod(uBg, spG / uRes, lod).g,
    textureLod(uBg, spB / uRes, lod).b);

  // 乳白玻璃透过率（0-255 色阶响应）：
  //   白 254→228、黑 0→38、红(242,51,61)→(255,33,45)、绿(49,229,115)→(0,227,80)
  // 两步：①灰阶响应 0.748·c + 38/255（压高提低）；②彩度向亮度两侧不对称
  // 扩张——亮侧 ×1.36、暗侧 ×2.09（彩底更鲜、暗通道下沉）。注意：这组系数
  // 是玻璃的光学响应，改任一系数即偏离上面的透过率表。
  col = col * 0.748 + vec3(38.0 / 255.0);
  float lumC = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 devC = col - vec3(lumC);
  col = vec3(lumC) + devC * mix(vec3(2.09), vec3(1.36), step(0.0, devC));

  // 对折线光带：映射斜率 → 0 的位置。收紧系数——折线是条细线不是宽带。
  float seam = exp(-abs(sPrime) * 14.0);

  // 环境取色（可关）：边缘反光的颜色取自玻璃周边背景（邻近元素的投影效果）。
  // 默认关（纯底光）；+0.25 常量底光兜底，暗背景上玻璃不融进背景。
  vec3 env = textureLod(uBg, (frag + n2d * (uBevel + 12.0)) / uRes, 1.5).rgb;
  vec3 sheen = vec3(0.25) + env * uEnvProj;

  // 边缘光学窗（绝对像素，常量）+ 贴边细线：勾住轮廓。
  // 指数钳在玻璃内（max(depth,0)），理由见上方「玻璃外」注释
  float win = exp(-2.0 * max(depth, 0.0) / 11.0);
  float rimLine = exp(-max(depth, 0.0) / 1.6);

  // Schlick 菲涅尔：掠射角反射率高 → 边缘天然比背景亮一点（各边皆然）。
  // 坡度用对折场的瞬时斜率（|s′| 处处可读）。
  float slope = abs(sPrime) * B / max(uBevel, 1.0);
  float fres = R0 + (1.0 - R0) * pow(1.0 - 1.0 / sqrt(1.0 + slope * slope), 5.0);

  // 合成：边缘反光 + 贴边细线 + 对折光带。纯黑背景上也有看得见的亮边。
  col += sheen * (fres * uRim * 0.85) * win;
  col += mix(sheen, vec3(1.0), 0.5) * rimLine * uRim * 0.5 * win;
  col += sheen * seam * uRim * 0.4;

  // 方向性轮廓：上/下边白色亮缘、左/右边黑色暗缘，两档在弯角渐隐到无
  //（白色两端接近弯曲的部分慢慢变淡、到对方直线边前消散，黑色同理）。
  // 带宽 ≈1px（衰减尺度 1.0px）——加宽会盖住边缘底图，观感变粗。
  float edgeLift = exp(-max(depth, 0.0) / 1.0);
  col += (1.0 - col) * edgeLift * maskW * 0.85;      // 白缘
  col *= 1.0 - edgeLift * maskB * 0.40;              // 黑缘

  float aa = smoothstep(fth, -fth, sd);
  outColor = vec4(mix(base, col, aa), 1.0);
}`;

// 背景上屏：背景纹理原样铺满画布（一次采样/像素）。玻璃 pass 只画包围盒，
// 画布其余部分由这一趟负责——玻璃着色器不为屏幕外的像素陪跑。
const BLIT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBg;
uniform vec2 uRes;
out vec4 outColor;
void main() {
  outColor = texture(uBg, gl_FragCoord.xy / uRes);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader 编译失败: ' + log);
  }
  return sh;
}

function program(gl, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program 链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

/**
 * 创建液态玻璃实例。引擎不内置任何背景——背景以全屏片元着色器从外部注入，
 * 引擎渲进背景纹理后做折射采样。
 * @param {HTMLCanvasElement} canvas
 * @param {{ background: string }} opts
 *   background: 全屏背景片元着色器（GLSL ES 3.0；可声明 uRes uniform 取分辨率、
 *   uTime uniform（秒）驱动动画）
 */
export function createLiquidGlass(canvas, opts) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
  if (!gl) throw new Error('需要 WebGL2');

  const bgProg = program(gl, opts.background);
  const blitProg = program(gl, BLIT_FRAG);
  const glassProg = program(gl, GLASS_FRAG);
  const vao = gl.createVertexArray();

  // 背景纹理 + 两块合成纹理。堆叠时乒乓：每层玻璃读「下面的合成结果」写进
  // 自己的目标，上层因此能折射到下层玻璃（而不是各画各的、上层盖掉下层）。
  const mkTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  const mkFbo = (tex) => {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return f;
  };
  const bgTex = mkTex();
  const compTexA = mkTex();
  const compTexB = mkTex();
  const bgFbo = mkFbo(bgTex);
  const compFboA = mkFbo(compTexA);
  const compFboB = mkFbo(compTexB);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const uni = (p) => {
    const out = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      out[info.name] = gl.getUniformLocation(p, info.name);
    }
    return out;
  };
  const bgU = uni(bgProg);
  const blitU = uni(blitProg);
  const gU = uni(glassProg);

  // 背景着色器声明 uTime 即视为动画背景（逐帧重画）；静态背景只在尺寸变化后画一次
  const bgAnimated = !!bgU.uTime;
  let bgDirty = true;

  /** 全局光学参数——每块面板未单独指定的字段回落到这里 */
  const params = {
    radius: 55, bevel: 25, dist: 50, fold: 2.6, bend: 3,
    blur: 1, disp: 0.5, rim: 0, feather: 0.5, envProj: 0,
  };

  /**
   * 玻璃面板数组（设备像素坐标，y 向上 —— 与 gl_FragCoord 一致）。
   * 数组顺序 = 堆叠顺序，自后向前：每块玻璃采样它下面的合成结果，
   * 包括更下层的玻璃——重叠处即「隔着上面的玻璃看下面被折射」。
   * 每项可覆盖 params 里的任意光学字段，未给出的回落到全局 params。
   */
  const rects = [{ x: 0, y: 0, w: 360, h: 160 }];
  let placed = false;

  const PKEYS = ['radius', 'bevel', 'dist', 'fold', 'bend', 'blur', 'disp', 'rim', 'feather', 'envProj'];
  const resolve = (r) => {
    const p = {};
    for (const k of PKEYS) p[k] = k in r ? r[k] : params[k];
    return p;
  };

  let raf = 0;
  let frames = 0;
  let fpsT = performance.now();
  let fps = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    bgDirty = true;
    for (const t of [bgTex, compTexA, compTexB]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    // 首次布局：停在 (0,0) 的面板视为未定位，自动居中；显式摆过位的不动
    if (!placed) {
      placed = true;
      for (const r of rects) {
        if (!r.x && !r.y) { r.x = w / 2; r.y = h / 2; }
      }
    }
  }

  /** 铺底：src 纹理原样铺进目标，保住玻璃包围盒以外的画面 */
  function blit(srcTex, dstFbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(blitProg);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(blitU.uBg, 0);
    gl.uniform2f(blitU.uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 一块玻璃：先铺底，再在包围盒内着色（采样的是铺底的源） */
  function drawPanel(srcTex, dstFbo, r, p) {
    blit(srcTex, dstFbo);
    // 包围盒余量 = max(采样距离, 环宽+12)〔折射采样与环境取色的最大外伸〕
    // + 羽化 + 24px〔外侧对比晕的衰减半径〕
    const reach = Math.max(p.dist, p.bevel + 12) + Math.max(p.feather, 0.5) + 24;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.floor(r.x - r.w / 2 - reach),
      Math.floor(r.y - r.h / 2 - reach),
      Math.ceil(r.w + reach * 2),
      Math.ceil(r.h + reach * 2));
    gl.useProgram(glassProg);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gU.uBg, 0);
    gl.uniform2f(gU.uRes, canvas.width, canvas.height);
    gl.uniform4f(gU.uRect, r.x, r.y, r.w / 2, r.h / 2);
    gl.uniform1f(gU.uRadius, p.radius);
    gl.uniform1f(gU.uBevel, p.bevel);
    gl.uniform1f(gU.uDist, p.dist);
    gl.uniform1f(gU.uFold, p.fold);
    gl.uniform1f(gU.uBend, p.bend);
    gl.uniform1f(gU.uBlur, p.blur);
    gl.uniform1f(gU.uDisp, p.disp);
    gl.uniform1f(gU.uRim, p.rim);
    gl.uniform1f(gU.uFeather, p.feather);
    gl.uniform1f(gU.uEnvProj, p.envProj);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    resize();

    // pass 1：背景进纹理——静态背景只在尺寸变化后重画（含 mipmap 重建，
    // 磨砂靠 LOD 采样）；动画背景逐帧推 uTime
    if (bgAnimated || bgDirty) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, bgFbo);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(bgProg);
      gl.bindVertexArray(vao);
      gl.uniform2f(bgU.uRes, canvas.width, canvas.height);
      if (bgU.uTime) gl.uniform1f(bgU.uTime, now * 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      bgDirty = false;
    }

    // pass 2：自后向前逐块合成。每块读下面的合成结果、写自己的目标；
    // 中间目标建 mipmap（下一层的磨砂要 LOD 采样），最后一块直接上屏。
    if (rects.length === 0) {
      blit(bgTex, null);
    } else {
      let srcTex = bgTex;
      for (let i = 0; i < rects.length; i++) {
        const last = i === rects.length - 1;
        const mid = i % 2 === 0;
        const dstFbo = last ? null : mid ? compFboA : compFboB;
        drawPanel(srcTex, dstFbo, rects[i], resolve(rects[i]));
        if (!last) {
          srcTex = mid ? compTexA : compTexB;
          gl.bindTexture(gl.TEXTURE_2D, srcTex);
          gl.generateMipmap(gl.TEXTURE_2D);
        }
      }
    }

    frames++;
    if (now - fpsT > 500) {
      fps = (frames * 1000) / (now - fpsT);
      frames = 0;
      fpsT = now;
    }
  }

  return {
    params,
    rects,
    /** 兼容单面板用法：第一块面板的别名 */
    get rect() { return rects[0]; },
    get fps() { return fps; },
    start() { if (!raf) raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    dispose() {
      this.stop();
      for (const t of [bgTex, compTexA, compTexB]) gl.deleteTexture(t);
      for (const f of [bgFbo, compFboA, compFboB]) gl.deleteFramebuffer(f);
      gl.deleteProgram(bgProg);
      gl.deleteProgram(blitProg);
      gl.deleteProgram(glassProg);
      gl.deleteVertexArray(vao);
    },
  };
}
