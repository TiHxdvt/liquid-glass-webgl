// liquid-glass-webgl — WebGL2 液态玻璃
// SPDX-License-Identifier: MIT
//
// 圆角矩形的有符号距离决定轮廓和对折深度。屏幕空间采样映射在边缘形成倒像，
// RGB 三通道的位移差产生色散。全分辨率分离高斯控制磨砂，RGSS 根据映射斜率覆盖采样足迹。

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
uniform vec4 uFoldShape;   // 折线深度、极小采样深度、外臂半轴、内臂弯曲长度
uniform float uInnerScale; // 软弯倍率的倒数
uniform float uDisp;       // 色散
uniform float uRim;        // 边缘反光强度
uniform float uTint;       // 玻色：0=纯透明，+1=浅色模式透过率，−1=深色模式透过率（绝对值=强度）
uniform float uEnvProj;    // 环境投影（0/1）：快靠近的元素投影到玻璃上，默认关
uniform float uPremult;    // 合成模式：1=预乘混合（单目标叠画多块玻璃），0=不透明写（逐层合成）
uniform vec4 uSoftRect;    // 磨砂纹理在绘制缓冲中的原点和尺寸
uniform sampler2D uSoft;   // 预模糊纹（分离高斯，见 BLUR_FRAG）——磨砂的唯一采样源
// 轮廓与折射颜色显式读取基级。scissor 边界的导数可能令隐式 LOD 跳到粗 mip，产生红黑接缝。

out vec4 outColor;

const float R0 = 0.04;     // ((η−1)/(η+1))² 正入射反射率

// 旋转网格超采样（RGSS）4 点：像素足迹的覆盖率采样位置（±0.375/±0.125）
const vec2 RGSS[4] = vec2[4](
  vec2(-0.125, -0.375), vec2(0.375, -0.125),
  vec2(-0.375, 0.125), vec2(0.125, 0.375));

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

// 直边和圆弧使用解析法线；在中轴、切点和小半径处保留 1.2px 中心差分的过渡。
vec2 rectNormal(vec2 p, vec2 b, float r) {
  const float e = 0.6;
  vec2 q = abs(p) - b + r;
  vec2 n;
  if (q.y < -e && q.x > q.y + 2.0 * e && abs(p.x) > e) {
    n = vec2(sign(p.x), 0.0);
  } else if (q.x < -e && q.y > q.x + 2.0 * e && abs(p.y) > e) {
    n = vec2(0.0, sign(p.y));
  } else if (min(q.x, q.y) > e && dot(q, q) > 64.0 && min(abs(p.x), abs(p.y)) > e) {
    n = normalize(q) * sign(p);
  } else {
    n = vec2(
      sdRoundRect(p + vec2(e, 0), b, r) - sdRoundRect(p - vec2(e, 0), b, r),
      sdRoundRect(p + vec2(0, e), b, r) - sdRoundRect(p - vec2(0, e), b, r)) / (2.0 * e);
  }
  return normalize(n + vec2(1e-6 / (2.0 * e)));
}

vec3 sampleSoft(vec2 pixel) {
  return textureLod(uSoft, (pixel - uSoftRect.xy) / uSoftRect.zw, 0.0).rgb;
}

// 彩度向亮度两侧不对称扩张——玻色两模式共用的第二步骨架（系数是各自
// 透过率表的响应，见下方标定表）
vec3 chromaExpand(vec3 c, float hi, float lo) {
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 dev = c - vec3(lum);
  return vec3(lum) + dev * mix(vec3(lo), vec3(hi), step(0.0, dev));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 rel = frag - uRect.xy;
  float rad = min(uRadius, min(uRect.z, uRect.w) - 1.0);
  float sd = sdRoundRect(rel, uRect.zw, rad);

  // ±0.5 设备像素形成轮廓覆盖带；体外提前退出以避免轮廓指数溢出。
  const float fth = 0.5;
  if (sd > fth) {
    // 预乘模式：底上已有画面（下层玻璃/背景），体外无增量可加
    outColor = uPremult > 0.5 ? vec4(0.0) : vec4(textureLod(uBg, frag / uRes, 0.0).rgb, 1.0);
    return;
  }

  // 方向场取加宽圆角的梯度（radDir = rad + 环宽）——只消角部中轴的梯度折痕，
  // 不参与轮廓形状。注意：倒像场深度必须取**真实边缘 SDF**——它的等深轮廓是
  // 可见边缘的精确内缩（角圆心恒同一点），与边缘永远同心；若用加宽 SDF 的
  // 深度，轮廓圆心随 radDir 漂移、且先于真实半径触钳，大圆角下调到 60-80
  // 会出现边缘折线、形状冻结。
  float radDir = min(rad + uBevel, min(uRect.z, uRect.w) - 0.5);
  vec2 n2d = rectNormal(rel, uRect.zw, radDir);
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
  // 折射几何与磨砂解耦：对折线固定于环深 d0，不随磨砂变化。磨砂是散射，
  // 均匀作用于折射后的画面；细纹理在高磨砂下的残影来自压缩区欠采样，
  // 由源头低通消除，不修改折射场。
  float fold = uFold;
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

  // 外侧四分之一椭圆由边界位移和折点深度确定，内外两臂在极小值处切向连续。
  float d0 = uFoldShape.x;
  float sMin = uFoldShape.y;
  float V = uFoldShape.z;
  float du0 = max(d0, 1e-3);
  float ue = clamp((d0 - depth) / du0, 0.0, 1.0);
  float ue2 = min(ue * ue, 0.999);
  float sOuter = sMin + V * (1.0 - sqrt(1.0 - ue2));
  float sOuterPrime = -V * ue / (du0 * sqrt(1.0 - ue2));   // 负：外侧倒序

  // 内侧曲率缩放保留折点的二次项，远离折点时 tanh 平滑趋向原始映射。
  float a = uInnerScale;
  float bend = uFoldShape.w;
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

  // 沿同一法向分离 RGB 采样点，蓝通道的位移最大。
  float disp = uDisp * 0.02;
  vec2 spR = frag + inward * shift * (1.0 - disp);
  vec2 spG = frag + inward * shift;
  vec2 spB = frag + inward * shift * (1.0 + disp);

  // 玻璃下磨砂：σ=blur px 的预模糊纹（分离高斯，见 BLUR_FRAG），均匀作用于
  // 折射后的画面（散射无方向性），全程线性、无档位切换。不做放大区锐化
  // 补偿：放大导致的模糊是成像物理（对折线附近应更模糊），补偿会使该区域
  // 保留过强局部对比。
  // 位移重采样锯齿的成因是相邻像素源侧采样点相隔 |s′| px，属欠采样。
  // 对策是按采样足迹做覆盖率超采样而非以模糊近似抗锯齿：每个像素的足迹
  //（源侧被 |s′| 拉伸的矩形）用 RGSS 4 点旋转网格取样，等价盒式超采样，
  // 曲线边缘无阶梯。|s′−1| 较小的平坦区退化为单次采样。
  float fp = clamp(sPrime, -6.0, 6.0);   // 足迹拉伸（极值钳幅，外缘交轮廓光管）
  bool split = uDisp >= 0.001;           // 色散开=三通道分采样；关=同点一次取样
  vec3 col;
  if (abs(fp - 1.0) > 0.2) {
    col = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec2 d = RGSS[i];
      // 显示偏移 d → 源侧偏移：切向 1:1，法向按 s′ 拉伸（足迹形状）
      vec2 off = d + inward * ((fp - 1.0) * dot(d, inward));
      col += split
        ? vec3(sampleSoft(spR + off).r,
               sampleSoft(spG + off).g,
               sampleSoft(spB + off).b)
        : sampleSoft(spG + off);
    }
    col *= 0.25;
  } else {
    col = split
      ? vec3(sampleSoft(spR).r,
             sampleSoft(spG).g,
             sampleSoft(spB).b)
      : sampleSoft(spG);
  }

  // 玻色透过率（玻璃自色）。uTint：0 纯透明，+1 浅色模式，−1 深色模式；绝对值是强度。
  // 浅色（标定表）：白 254→228、黑 0→38、红(242,51,61)→(255,33,45)、
  //   绿(49,229,115)→(0,227,80)。两步：①灰阶响应 0.748·c+38/255（压高提低）；
  //   ②彩度向亮度两侧不对称扩张——亮侧 ×1.36、暗侧 ×2.09（彩底更鲜、暗通道下沉）。
  // 深色（同法标定）：白 255→176、中灰 115→99、黑 0→12、红(217,34,41)→(229,0,23)、
  //   绿(49,229,115)→(0,182,58)。两步：①灰阶幂调 0.047+0.643·c^0.8（压高更狠、
  //   黑位微提，白/中灰/黑三点定线）；②彩度扩张——亮侧 ×1.8、暗侧 ×2.25
  //（彩度两色取残差平衡；灰阶三点全中，彩色 ±10 上下）。
  // 注意：系数是玻璃的光学响应，改任一系数即偏离上面的透过率表。
  vec3 tinted = uTint >= 0.0
    ? chromaExpand(col * 0.748 + vec3(38.0 / 255.0), 1.36, 2.09)
    : chromaExpand(vec3(0.047) + pow(max(col, vec3(0.0)), vec3(0.8)) * 0.643, 1.8, 2.25);
  col = mix(col, tinted, clamp(abs(uTint), 0.0, 1.0));

  if (uRim != 0.0) {
    vec3 sheen = vec3(0.25);
    if (uEnvProj != 0.0) {
      float lod = 1.5 + log2(max(float(textureSize(uBg, 0).x) / uRes.x, 1e-3));
      sheen += textureLod(uBg, (frag + n2d * (uBevel + 12.0)) / uRes, lod).rgb * uEnvProj;
    }
    float win = exp(-2.0 * max(depth, 0.0) / 11.0);
    float rimLine = exp(-max(depth, 0.0) / 1.6);
    float slope = abs(sPrime);
    float fres = R0 + (1.0 - R0) * pow(1.0 - 1.0 / sqrt(1.0 + slope * slope), 5.0);
    col += sheen * (fres * uRim * 0.85) * win;
    col += mix(sheen, vec3(1.0), 0.5) * rimLine * uRim * 0.5 * win;
    col += sheen * exp(-abs(sPrime) * 14.0) * uRim * 0.4;
  }

  // 方向性轮廓使用真实半径；折射的加宽半径会改变角部亮边的方向。
  vec2 nRim = rectNormal(rel, uRect.zw, rad);
  float maskB = atan(abs(nRim.x), abs(nRim.y)) / 1.5708;
  float maskW = 1.0 - maskB;
  float edgeLift = exp(-max(depth, 0.0) / 1.0);
  col += (1.0 - col) * edgeLift * maskW * 0.85;      // 白缘
  col *= 1.0 - edgeLift * maskB * 0.40;              // 黑缘

  float aa = 1.0 - smoothstep(-fth, fth, sd);
  if (uPremult > 0.5) {
    // 预乘 over：玻璃体不透明（aa→1 时 alpha=1），轮廓过渡带按覆盖度渐变
    outColor = vec4(col * aa, aa);
  } else {
    outColor = vec4(mix(textureLod(uBg, frag / uRes, 0.0).rgb, col, aa), 1.0);
  }
}`;

// 磨砂预模糊：分离高斯，横纵各一趟（13 抽头 = 中心 ±6 对），σ/2 间距、±3σ 截断。
// 离散和 Σwᵢ·f(x+i·d) 仅当 f 带限（平滑）时逼近真卷积；细线（≈2px）比抽头
// 间距窄时会被离散抽头解成等间距亮斑（周期 = 间距）。故取样带预滤波 lod：
// 盒宽 ≈ 2d = σ，由 mip 链的盒滤提供；无 mipmap 的源（层间合成纹理）
// textureLod 钳到 0，调用方需先 generateMipmap。纵趟的源（横趟产物）同样
// 无 mipmap、lod 钳 0——无须补充：横趟每次取样的 mip 盒滤各向同性，产物在
// 两轴均已带限，纵趟抽头的输入已是带限内容。
// 预滤波使有效核略微加宽（σ_eff≈1.04σ），视觉差异可忽略。
// 输出全分辨率——半分辨率存在 ~1px 帐篷重建地板，σ 较小时模糊量受限。
// 两趟 uv 步进同口径（σ/2 源像素折算），各向同性。
const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBg;
uniform vec2 uRes;       // 输入纹理在画布中覆盖的尺寸
uniform vec2 uOffset;    // 输出原点相对输入原点的设备像素偏移
uniform vec2 uMaxUV;     // 中间纹理可复用较大存储，采样限于本趟写入的像素
uniform vec2 uSpacing;   // 相邻抽头的 uv 步进（单轴）：σ/2 源像素折算
out vec4 outColor;
void main() {
  vec2 uv = (gl_FragCoord.xy + uOffset) / uRes;
  // 预滤波 lod：抽头间距（纹素口径）≈ 2×uSpacing×纹素数，盒宽取 2d
  vec2 ts = vec2(textureSize(uBg, 0));
  float lod = log2(max(max(uSpacing.x * ts.x, uSpacing.y * ts.y) * 2.0, 1.0));
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    // 抽头位 = i·σ/2 → t = 位/σ = i/2，权重 exp(-t²/2) = exp(-i²/8)
    float wgt = exp(-0.5 * (fi * 0.5) * (fi * 0.5));
    acc += wgt * textureLod(uBg, min(uv + uSpacing * fi, uMaxUV), lod).rgb;
    wsum += wgt;
  }
  outColor = vec4(acc / wsum, 1.0);
}`;

// 铺底拷贝：把源纹理原样铺进目标（每像素一次采样）。玻璃 pass 只画包围盒，
// 目标的其余部分由这一趟负责——玻璃着色器不处理无关像素。
const BLIT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uBg;
uniform vec2 uRes;
out vec4 outColor;
void main() {
  outColor = textureLod(uBg, gl_FragCoord.xy / uRes, 0.0);
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
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  let fs, handle;
  try {
    fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    handle = gl.createProgram();
    gl.attachShader(handle, vs);
    gl.attachShader(handle, fs);
    gl.linkProgram(handle);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(handle));
    const uniforms = {};
    const count = gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const { name } = gl.getActiveUniform(handle, i);
      uniforms[name] = gl.getUniformLocation(handle, name);
    }
    return { handle, uniforms };
  } catch (err) {
    if (handle) gl.deleteProgram(handle);
    throw err;
  } finally {
    gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
  }
}

const DEFAULTS = {
  radius: 55, bevel: 25, dist: 50, fold: 2.6, bend: 3,
  blur: 1, tint: 1, disp: 0.5, rim: 0, envProj: 0,
};
/** @typedef {typeof DEFAULTS} GlassParams */
/** @typedef {{ x: number, y: number, w: number, h: number } & Partial<GlassParams>} GlassRect */
/** @typedef {{ background?: string, transparent?: boolean, nested?: boolean }} GlassOptions */
/** @typedef {{ preflipped?: boolean, version?: number | string }} BackgroundOptions */

const OPTICS = Object.keys(DEFAULTS);
const GEOMETRY = ['x', 'y', 'w', 'h'];

function foldShape(p) {
  const bevel = Math.max(p.bevel, 1);
  const fold = Math.max(p.fold, 1);
  const exponent = Math.max(fold - 1, 0.001);
  const k = Math.min(10, Math.max(1, p.bend));
  const ratio = Math.min(1, bevel / Math.max(p.dist * fold, 0.001));
  const t0 = 1 - Math.pow(ratio, 1 / exponent);
  const depth = t0 * bevel;
  const min = depth + p.dist * Math.pow(1 - t0, fold);
  return { depth, min, span: Math.max(p.dist - min, 0.5),
    length: Math.max(bevel * (1 - t0) * k / exponent, 0.5), scale: 1 / k };
}

function dependReach(p) {
  return Math.max(p.dist, p.bevel + 12, 3 * Math.max(p.blur, 0.5) + 12) + 2;
}

function overlap(a, b) {
  const margin = dependReach(a.p) + dependReach(b.p);
  return Math.abs(a.x - b.x) * 2 < a.w + b.w + margin * 2
    && Math.abs(a.y - b.y) * 2 < a.h + b.h + margin * 2;
}

function sourceSize(src) {
  // image/video 的元素布局尺寸可以与上传的原始图像尺寸不同。
  return [src.videoWidth ?? src.naturalWidth ?? src.displayWidth ?? src.width,
    src.videoHeight ?? src.naturalHeight ?? src.displayHeight ?? src.height];
}

/**
 * @typedef {{
 *   readonly params: GlassParams,
 *   readonly rects: GlassRect[],
 *   readonly rect: GlassRect | undefined,
 *   readonly fps: number,
 *   nested: boolean,
 *   setBackground(source: TexImageSource | null, options?: BackgroundOptions): void,
 *   invalidate(): void,
 *   render(now?: number, width?: number, height?: number): void,
 *   start(options?: { onDemand?: boolean }): void,
 *   stop(): void,
 *   dispose(): void
 * }} LiquidGlass
 */

/**
 * 创建 WebGL2 液态玻璃。坐标和磨砂标准差均使用设备像素，原点位于画布左下。
 * @param {HTMLCanvasElement} canvas
 * @param {GlassOptions} [opts]
 * @returns {LiquidGlass}
 */
export function createLiquidGlass(canvas, opts = {}) {
  const { transparent = false, background } = opts;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: !!transparent, depth: false });
  if (!gl) throw new Error('需要 WebGL2');
  if (gl.getContextAttributes()?.alpha !== !!transparent) {
    throw new Error('transparent 必须与画布已有 WebGL 上下文的 alpha 属性一致');
  }
  const params = { ...DEFAULTS };
  /** @type {GlassRect[]} */
  const rects = [{ x: 0, y: 0, w: 360, h: 160 }];
  const panels = [];
  const programs = {};
  const layers = [];
  const softCache = new Map();
  let cachePixels = 0;
  let vao, bg, scratch;
  let external = null;
  let flipCanvas = null;
  let nested = !!opts.nested;
  let serial = 0, bgRevision = 0;
  let width = 0, height = 0;
  let placed = false, bgDirty = true, dirty = true;
  let lost = false, disposed = false;
  let running = false, onDemand = false, raf = null;
  let frames = 0, fps = 0, fpsStart = performance.now(), lastDraw = -Infinity;
  let cssWidth, cssHeight;

  function target(mips = false) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w: 0, h: 0 };
  }

  function allocate(t, w, h) {
    if (t.w === w && t.h === h) return;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    t.w = w;
    t.h = h;
  }

  function release(t) {
    if (t && !lost) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
  }

  function releaseLayers() {
    for (const layer of layers) release(layer);
    layers.length = 0;
  }

  function clearBuffers() {
    releaseLayers();
    for (const t of softCache.values()) release(t);
    softCache.clear();
    cachePixels = 0;
    release(scratch);
    scratch = null;
  }

  function releaseGPU() {
    clearBuffers();
    release(bg);
    bg = null;
    for (const key of Object.keys(programs)) {
      if (!lost) gl.deleteProgram(programs[key].handle);
      delete programs[key];
    }
    if (vao && !lost) gl.deleteVertexArray(vao);
    vao = null;
  }

  function initGPU() {
    try {
      if (background) programs.bg = program(gl, background);
      programs.blit = program(gl, BLIT_FRAG);
      programs.glass = program(gl, GLASS_FRAG);
      programs.blur = program(gl, BLUR_FRAG);
      vao = gl.createVertexArray();
      bg = target(true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } catch (err) {
      releaseGPU();
      throw err;
    }
  }
  initGPU();

  function queueFrame() {
    if (running && !lost && !disposed && raf === null) raf = requestAnimationFrame(frame);
  }

  function invalidate() {
    dirty = true;
    queueFrame();
  }

  function resize(targetW, targetH) {
    let w, h;
    if (targetW > 0 && targetH > 0) {
      w = Math.round(targetW);
      h = Math.round(targetH);
    } else {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.round((cssWidth ?? canvas.clientWidth) * dpr);
      h = Math.round((cssHeight ?? canvas.clientHeight) * dpr);
    }
    if (w <= 0 || h <= 0) return false;
    if (w === width && h === height && canvas.width === w && canvas.height === h) return true;
    width = w;
    height = h;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    clearBuffers();
    bgDirty = dirty = true;
    if (!placed) {
      placed = true;
      for (const r of rects) {
        if (!r.x && !r.y) { r.x = w / 2; r.y = h / 2; }
      }
    }
    return true;
  }

  function upload(src, preflipped) {
    const [w, h] = sourceSize(src);
    if (!(w > 0 && h > 0)) throw new Error('背景图像尚无可上传的像素');
    // UNPACK_FLIP_Y_WEBGL 对 ImageBitmap 无效，借助 2D 画布保留默认翻转语义。
    if (!preflipped && typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) {
      flipCanvas ??= document.createElement('canvas');
      if (flipCanvas.width !== w) flipCanvas.width = w;
      if (flipCanvas.height !== h) flipCanvas.height = h;
      const ctx = flipCanvas.getContext('2d');
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(src, 0, 0);
      src = flipCanvas;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bg.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !preflipped);
    try {
      if (w === bg.w && h === bg.h) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      }
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    bg.w = w;
    bg.h = h;
    gl.generateMipmap(gl.TEXTURE_2D);
    bgRevision = ++serial;
    return src;
  }

  function setBackground(src, options) {
    if (disposed) return;
    const { preflipped = false, version } = options ?? {};
    if (!src) {
      external = null;
      bgDirty = true;
    } else {
      const [w, h] = sourceSize(src);
      if (!(w > 0 && h > 0) || ('videoWidth' in src && src.readyState < 2)) return;
      if (version !== undefined && external?.src === src && external.version === version
          && external.preflipped === preflipped && external.w === w && external.h === h) return;
      const replay = lost ? src : upload(src, preflipped);
      external = { src, preflipped, version, w, h, replay };
    }
    invalidate();
  }

  function bindTarget(fbo, srcTex, w = width, h = height) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
  }

  function drawBackground(now) {
    // 外部小图与着色器背景共用纹理，切回时必须独立校准附件尺寸。
    allocate(bg, width, height);
    bindTarget(bg.fbo, null);
    if (programs.bg) {
      const { handle, uniforms } = programs.bg;
      gl.useProgram(handle);
      if (uniforms.uRes) gl.uniform2f(uniforms.uRes, width, height);
      if (uniforms.uTime) gl.uniform1f(uniforms.uTime, now * 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindTexture(gl.TEXTURE_2D, bg.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    bgRevision = ++serial;
    bgDirty = false;
  }

  function blit(src, dst) {
    bindTarget(dst, src.tex);
    const { handle, uniforms } = programs.blit;
    gl.useProgram(handle);
    gl.uniform1i(uniforms.uBg, 0);
    gl.uniform2f(uniforms.uRes, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function layerAt(i) {
    const layer = layers[i] ??= target();
    allocate(layer, width, height);
    return layer;
  }

  // 快照只比较参与绘制的数值，同时支持外部持有 rect 引用并直接修改。
  function syncPanels() {
    let changed = panels.length !== rects.length;
    while (panels.length > rects.length) {
      const slot = removeCached(panels.pop());
      release(slot);
    }
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const panel = panels[i] ??= { p: {} };
      const p = panel.p;
      let update = !panel.shape;
      const shapeChanged = !panel.shape || p.dist !== (r.dist ?? params.dist)
        || p.bevel !== (r.bevel ?? params.bevel) || p.fold !== (r.fold ?? params.fold)
        || p.bend !== (r.bend ?? params.bend);
      for (const key of GEOMETRY) {
        if (panel[key] !== r[key]) { panel[key] = r[key]; update = true; }
      }
      for (const key of OPTICS) {
        const value = r[key] ?? params[key];
        if (p[key] !== value) { p[key] = value; update = true; }
      }
      if (shapeChanged) panel.shape = foldShape(p);
      if (update) {
        panel.revision = ++serial;
        changed = true;
      }
    }
    return changed;
  }

  function removeCached(panel) {
    const t = softCache.get(panel);
    if (t) {
      softCache.delete(panel);
      cachePixels -= t.w * t.h;
    }
    return t;
  }

  // 最终磨砂结果按面板缓存，合计至多占一张画布。淘汰时复用纹理对象。
  function reserveSoft(panel, w, h) {
    let t = removeCached(panel);
    while (cachePixels + w * h > width * height && softCache.size) {
      const oldest = removeCached(softCache.keys().next().value);
      if (t) release(oldest);
      else t = oldest;
    }
    t ??= target();
    allocate(t, w, h);
    softCache.set(panel, t);
    cachePixels += w * h;
    return t;
  }

  function blurSource(src, revision, panel) {
    const { p } = panel;
    const sigma = Math.max(p.blur, 0.5);
    const reach = Math.abs(p.dist) * (1 + 0.02 * Math.abs(p.disp)) + 6;
    // 两趟均保留设备像素分辨率。定宽区域在画布边界内平移，拖动不会逐像素重分配。
    const w = Math.min(width, Math.max(1, Math.ceil(panel.w + reach * 2 + 2)));
    const h = Math.min(height, Math.max(1, Math.ceil(panel.h + reach * 2 + 2)));
    const x = Math.max(0, Math.min(width - w, Math.floor(panel.x - w / 2)));
    const y = Math.max(0, Math.min(height - h, Math.floor(panel.y - h / 2)));
    const cached = softCache.get(panel);
    if (cached && cached.revision === revision && cached.sigma === sigma
        && cached.x === x && cached.y === y && cached.w === w && cached.h === h) {
      softCache.delete(panel);
      softCache.set(panel, cached);
      return cached;
    }

    // 纵向卷积需要横趟在上下各多覆盖 3σ，加一像素覆盖线性插值足迹。
    const pad = Math.ceil(3 * sigma) + 1;
    const sh = Math.min(height, h + 2 * pad);
    const sy = Math.max(0, Math.min(height - sh, y - pad));
    const result = reserveSoft(panel, w, h);
    scratch ??= target();
    allocate(scratch, Math.max(scratch.w, w), Math.max(scratch.h, sh));
    const { handle, uniforms } = programs.blur;
    gl.useProgram(handle);
    gl.uniform1i(uniforms.uBg, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    bindTarget(scratch.fbo, src.tex, w, sh);
    gl.uniform2f(uniforms.uRes, width, height);
    gl.uniform2f(uniforms.uOffset, x, sy);
    gl.uniform2f(uniforms.uMaxUV, 1, 1);
    gl.uniform2f(uniforms.uSpacing, sigma / (2 * width), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    bindTarget(result.fbo, scratch.tex, w, h);
    gl.uniform2f(uniforms.uRes, scratch.w, scratch.h);
    gl.uniform2f(uniforms.uMaxUV, (w - 0.5) / scratch.w, (sh - 0.5) / scratch.h);
    gl.uniform2f(uniforms.uOffset, 0, y - sy);
    gl.uniform2f(uniforms.uSpacing, 0, sigma / (2 * scratch.h));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    Object.assign(result, { x, y, revision, sigma });
    return result;
  }

  function drawGlass(panel, src, soft, dst, premult) {
    const { p, shape } = panel;
    bindTarget(dst, src.tex);
    const x = Math.floor(panel.x - panel.w / 2 - 2);
    const y = Math.floor(panel.y - panel.h / 2 - 2);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, Math.ceil(panel.w + 4), Math.ceil(panel.h + 4));
    const { handle, uniforms: u } = programs.glass;
    gl.useProgram(handle);
    gl.uniform1i(u.uBg, 0);
    gl.uniform1i(u.uSoft, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, soft.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform4f(u.uSoftRect, soft.x, soft.y, soft.w, soft.h);
    gl.uniform2f(u.uRes, width, height);
    gl.uniform4f(u.uRect, panel.x, panel.y, panel.w / 2, panel.h / 2);
    gl.uniform1f(u.uRadius, p.radius);
    gl.uniform1f(u.uBevel, p.bevel);
    gl.uniform1f(u.uDist, p.dist);
    gl.uniform1f(u.uFold, Math.max(p.fold, 1));
    gl.uniform4f(u.uFoldShape, shape.depth, shape.min, shape.span, shape.length);
    gl.uniform1f(u.uInnerScale, shape.scale);
    gl.uniform1f(u.uDisp, p.disp);
    gl.uniform1f(u.uRim, p.rim);
    gl.uniform1f(u.uTint, p.tint);
    gl.uniform1f(u.uEnvProj, p.envProj);
    gl.uniform1f(u.uPremult, premult);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  function drawFlat() {
    if (transparent) {
      bindTarget(null, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      blit(bg, null);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const panel of panels) {
      const soft = blurSource(bg, bgRevision, panel);
      drawGlass(panel, bg, soft, null, 1);
    }
    gl.disable(gl.BLEND);
  }

  function drawLayers() {
    let src = bg, revision = bgRevision;
    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];
      const dst = i + 1 < panels.length ? layerAt(i % 2) : null;
      if (dst) {
        // 逻辑版本跟踪整段下层合成，独立于反复写入的乒乓纹理。
        if (panel.below !== revision || panel.composedFrom !== panel.revision) {
          panel.below = revision;
          panel.composedFrom = panel.revision;
          panel.composite = ++serial;
        }
        if (dst.contentRevision === panel.composite) {
          src = dst;
          revision = panel.composite;
          continue;
        }
      }
      blit(src, dst?.fbo ?? null);
      const p = panel.p;
      if (src !== bg && src.mipRevision !== revision && (p.blur > 1 || (p.rim && p.envProj))) {
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        src.mipRevision = revision;
      }
      const soft = blurSource(src, revision, panel);
      drawGlass(panel, src, soft, dst?.fbo ?? null, 0);
      if (dst) {
        dst.contentRevision = panel.composite;
        revision = panel.composite;
        src = dst;
      }
    }
  }

  function animated() {
    return !external && !!programs.bg?.uniforms.uTime;
  }

  function paint(now, w, h, force) {
    if (disposed || lost || !resize(w, h)) return;
    const changed = syncPanels();
    if (!force && !dirty && !changed && !animated()) return;
    gl.bindVertexArray(vao);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    if (!external && (bgDirty || animated())) drawBackground(now);
    const layered = nested && !transparent && panels.some((p, i) =>
      panels.some((other, j) => j < i && overlap(p, other)));
    if (layered) drawLayers();
    else drawFlat();
    dirty = false;
    const time = performance.now();
    if (time - lastDraw > 600) { fpsStart = time; frames = 0; fps = 0; }
    lastDraw = time;
    frames++;
    if (time - fpsStart >= 500) {
      fps = frames * 1000 / (time - fpsStart);
      fpsStart = time;
      frames = 0;
    }
  }

  function frame(now) {
    raf = null;
    paint(now, undefined, undefined, false);
    if (!onDemand || animated()) queueFrame();
  }

  function cancelFrame() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  function contextLost(event) {
    event.preventDefault();
    lost = true;
    cancelFrame();
    releaseGPU();
  }

  function contextRestored() {
    lost = false;
    initGPU();
    bgDirty = true;
    if (external) {
      // ImageBitmap / VideoFrame 可由调用方关闭。恢复时保留仍可读取的源。
      const { replay, preflipped } = external;
      try {
        if (sourceSize(replay).every(n => n > 0)) external.replay = upload(replay, preflipped);
        else external = null;
      } catch (err) {
        if (err.name !== 'InvalidStateError' && err.name !== 'SecurityError') throw err;
        external = null;
      }
    }
    invalidate();
    if (!running && width && height) paint(performance.now(), width, height, true);
  }

  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(([entry]) => {
    const { width: w, height: h } = entry.contentRect;
    if (w === cssWidth && h === cssHeight) return;
    cssWidth = w;
    cssHeight = h;
    queueFrame();
  }) : null;
  observer?.observe(canvas);
  if (!observer) window.addEventListener('resize', queueFrame);
  let dprQuery;
  function watchDpr() {
    dprQuery?.removeEventListener('change', watchDpr);
    dprQuery = window.matchMedia?.('(resolution: ' + window.devicePixelRatio + 'dppx)');
    dprQuery?.addEventListener('change', watchDpr);
    queueFrame();
  }
  watchDpr();

  return {
    params, rects, setBackground, invalidate,
    get rect() { return rects[0]; },
    get nested() { return nested; },
    set nested(value) {
      if (nested === !!value) return;
      nested = !!value;
      if (!nested) releaseLayers();
      invalidate();
    },
    get fps() { return performance.now() - lastDraw > 600 ? 0 : fps; },
    render(now, w, h) {
      if (!running) paint(Number.isFinite(now) ? now : performance.now(), w, h, true);
    },
    start(options = {}) {
      if (disposed || (running && onDemand === !!options.onDemand)) return;
      onDemand = !!options.onDemand;
      running = true;
      invalidate();
    },
    stop() { running = false; cancelFrame(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancelFrame();
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', queueFrame);
      dprQuery?.removeEventListener('change', watchDpr);
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      releaseGPU();
      external = flipCanvas = null;
    },
  };
}
