// liquid-glass-webgl — 液态玻璃引擎（WebGL2 单遍着色器）
// SPDX-License-Identifier: MIT（见 LICENSE）
//
// 光学内核（教科书公式，公有领域）：
//   几何  圆角矩形解析 SDF；方向场取加宽圆角的梯度，消掉角部中轴折痕
//   折射  倒角顶面剖面 → 坡面倾角 α → 斯涅尔 β=asin(sinα/η) →
//         横向位移 = 入射点玻璃厚度 × tan(α−β)，边缘最大、向内平滑归零
//   能量  位移场导数 m′ → 采样密度 1+m′：发散压暗、汇聚提亮
//   磨砂  分离高斯预模糊纹（全分辨率、13 抽头×2 趟）均匀作用于折射后的画面，
//         σ=blur px 全程线性；折射几何不随磨砂移动；RGSS 足迹超采样消位移锯齿
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
uniform float uDisp;       // 色散
uniform float uRim;        // 边缘反光强度
uniform float uTint;       // 玻色：0=纯透明，+1=浅色模式透过率，−1=深色模式透过率（绝对值=强度）
uniform float uEnvProj;    // 环境投影（0/1）：快靠近的元素投影到玻璃上，默认关
uniform float uPremult;    // 合成模式：1=预乘混合（单目标叠画多块玻璃），0=不透明写（逐层合成）
uniform sampler2D uSoft;   // 预模糊纹（分离高斯，见 BLUR_FRAG）——磨砂的唯一采样源
// 取样一律 textureLod(..., 0)：texture() 的自动 lod 在 scissor 边界的残缺 quad
// 上导数爆炸、跳读粗 mip（粗 mip=场景均色→红/黑伪影缝），驱动相关、随拖拽闪烁

out vec4 outColor;

const float IOR = 1.5;
const float R0 = 0.04;     // ((η−1)/(η+1))² 正入射反射率

// 旋转网格超采样（RGSS）4 点：像素足迹的覆盖率采样位置（±0.375/±0.125）
const vec2 RGSS[4] = vec2[4](
  vec2(-0.125, -0.375), vec2(0.375, -0.125),
  vec2(-0.375, 0.125), vec2(0.125, 0.375));

float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
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

  // 玻璃外：不进折射/轮廓数学。注意：一切 exp(-depth/k) 型轮廓项
  // 必须钳在玻璃内（max(depth,0)）——玻璃外 depth<0 时指数溢出为 Inf，
  // Inf×0=NaN 会把大片画面抹黑，黑区边界沿遮罩零线走，呈直边状假投影。
  // 轮廓过渡宽固定 0.5px（±0.5px 共 1px 的覆盖渐变），仅用于抗锯齿，
  // 不作为视觉参数：过窄则圆角出现台阶，过宽则轮廓锐度损失
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
  // 折射几何与磨砂解耦：对折线固定于环深 d0，不随磨砂变化。磨砂是散射，
  // 均匀作用于折射后的画面；细纹理在高磨砂下的残影来自压缩区欠采样，
  // 由源头低通消除，不修改折射场。
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
        ? vec3(textureLod(uSoft, (spR + off) / uRes, 0.0).r,
               textureLod(uSoft, (spG + off) / uRes, 0.0).g,
               textureLod(uSoft, (spB + off) / uRes, 0.0).b)
        : textureLod(uSoft, (spG + off) / uRes, 0.0).rgb;
    }
    col *= 0.25;
  } else {
    col = split
      ? vec3(textureLod(uSoft, spR / uRes, 0.0).r,
             textureLod(uSoft, spG / uRes, 0.0).g,
             textureLod(uSoft, spB / uRes, 0.0).b)
      : textureLod(uSoft, spG / uRes, 0.0).rgb;
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

  // 对折线光带：映射斜率 → 0 的位置。收紧系数——折线是条细线不是宽带。
  float seam = exp(-abs(sPrime) * 14.0);

  // 环境取色（可关）：边缘反光的颜色取自玻璃周边背景（邻近元素的投影效果）。
  // 默认关（纯底光）；+0.25 常量底光兜底，暗背景上玻璃不融进背景。
  // lod 按源/画布尺寸折算成屏幕口径——固定 1.5 只对同尺寸源成立，小图源
  //（setBackground 允许分辨率不同）会被整图平均成全局色，环境色失真
  float envLod = 1.5 + log2(max(float(textureSize(uBg, 0).x) / uRes.x, 1e-3));
  vec3 env = textureLod(uBg, (frag + n2d * (uBevel + 12.0)) / uRes, envLod).rgb;
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
uniform vec2 uRes;       // 本 pass 目标分辨率——frag/uRes 即归一化 UV
uniform vec2 uSpacing;   // 相邻抽头的 uv 步进（单轴）：σ/2 源像素折算
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // 预滤波 lod：抽头间距（纹素口径）≈ 2×uSpacing×纹素数，盒宽取 2d
  vec2 ts = vec2(textureSize(uBg, 0));
  float lod = log2(max(max(uSpacing.x * ts.x, uSpacing.y * ts.y) * 2.0, 1.0));
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    // 抽头位 = i·σ/2 → t = 位/σ = i/2，权重 exp(-t²/2) = exp(-i²/8)
    float wgt = exp(-0.5 * (fi * 0.5) * (fi * 0.5));
    acc += wgt * textureLod(uBg, uv + uSpacing * fi, lod).rgb;
    wsum += wgt;
  }
  outColor = vec4(acc / wsum, 1.0);
}`;

// 铺底拷贝：把源纹理原样铺进目标（每像素一次采样）。玻璃 pass 只画包围盒，
// 目标的其余部分由这一趟负责——玻璃着色器不处理无关像素。
// 不用 gl.blitFramebuffer：Apple 的 tile-based GPU 上它要强制搬运缓冲，比
// 全屏着色器 pass 更贵，且与默认帧缓冲格式不保证兼容（静默失败 = 黑屏）。
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
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  // 链接成功后着色器对象即可释放（dispose+重建循环下不留无主对象）
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program 链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

/**
 * 创建液态玻璃实例。引擎不内置任何背景——背景从外部注入，两种方式：
 * ① opts.background：全屏片元着色器（GLSL ES 3.0；可声明 uRes uniform 取分辨率、
 *    uTime uniform（秒）驱动动画）；② setBackground(src)：每帧喂一幅现成画面
 *   （canvas / ImageBitmap 等 TexImageSource），引擎上传为折射采样源。
 * @param {HTMLCanvasElement} canvas
 * @param {{ background?: string, transparent?: boolean, nested?: boolean }} opts
 *   transparent: 三明治模式——画布透明、不铺底，只画玻璃本体，页面真实背景
 *   从画布透出（DOM 混合模式不受影响）。配合 setBackground 把下方背景喂进来采样
 *   nested: 重叠玻璃的光学嵌套（上层折射下层），默认关；transparent 模式下不生效
 */
export function createLiquidGlass(canvas, opts = {}) {
  const transparent = !!opts.transparent;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: transparent, depth: false });
  if (!gl) throw new Error('需要 WebGL2');
  // getContext 的属性在首调时定死、后续调用被忽略——同画布重建实例时
  // transparent 必须与既有上下文一致，否则混合/清屏分支与画布行为不符
  if ((gl.getContextAttributes()?.alpha ?? false) !== transparent) {
    throw new Error('transparent 与画布既有 WebGL 上下文不一致（getContext 属性首调定死）');
  }

  const bgProg = opts.background ? program(gl, opts.background) : null;
  const blitProg = program(gl, BLIT_FRAG);
  const glassProg = program(gl, GLASS_FRAG);
  const blurProg = program(gl, BLUR_FRAG);
  const vao = gl.createVertexArray();

  // 背景纹理 + 两块合成纹理。堆叠时乒乓：每层玻璃读「下面的合成结果」写进
  // 自己的目标，上层因此能折射到下层玻璃（而不是各画各的、上层盖掉下层）。
  const mkTex = (mips) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 背景纹理建 mipmap（玻璃的 LOD 磨砂要）；层间合成纹理不建——省掉每帧
    // 两次全屏 mipmap 重建——被当作磨砂模糊源时由 blurSource 补建
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  const mkFbo = (tex) => {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return f;
  };
  const bgTex = mkTex(true);
  // transparent 三明治模式下 needLayers 恒为 false，不分配两张全屏层间合成纹与 FBO（省显存与 resize 开销）
  const compTexA = transparent ? null : mkTex(false);
  const compTexB = transparent ? null : mkTex(false);
  // 磨砂柔纹 ×2（乒乓）：全分辨率、无 mipmap——分离高斯在这上面卷
  const blurTexA = mkTex(false);
  const blurTexB = mkTex(false);
  const bgFbo = mkFbo(bgTex);
  const compFboA = compTexA ? mkFbo(compTexA) : null;
  const compFboB = compTexB ? mkFbo(compTexB) : null;
  const blurFboA = mkFbo(blurTexA);
  const blurFboB = mkFbo(blurTexB);
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
  const bgU = bgProg ? uni(bgProg) : {};
  const blitU = uni(blitProg);
  const gU = uni(glassProg);
  const blurU = uni(blurProg);

  // 背景进纹理的两条路：setBackground() 外部喂画面（纹理模式，优先），
  // 或 background 着色器自渲（声明 uTime = 动画背景逐帧重画，否则只在 resize 后画）
  let bgTexture = false;
  const bgAnimated = !!bgU.uTime;
  let bgDirty = true;

  // 嵌套折射（默认关）：开 = 重叠的玻璃逐层合成、上层折射下层；关 = 单目标叠画
  let nested = !!opts.nested;

  /** 全局光学参数——每块面板未单独指定的字段回落到这里 */
  const params = {
    radius: 55, bevel: 25, dist: 50, fold: 2.6, bend: 3,
    blur: 1, tint: 1, disp: 0.5, rim: 0, envProj: 0,
  };

  /**
   * 玻璃面板数组（设备像素坐标，y 向上 —— 与 gl_FragCoord 一致）。
   * 数组顺序 = 堆叠顺序，自后向前：每块玻璃采样它下面的合成结果，
   * 包括更下层的玻璃——重叠处即「隔着上面的玻璃看下面被折射」。
   * 每项可覆盖 params 里的任意光学字段，未给出的回落到全局 params。
   */
  const rects = [{ x: 0, y: 0, w: 360, h: 160 }];
  let placed = false;

  const PKEYS = ['radius', 'bevel', 'dist', 'fold', 'bend', 'blur', 'tint', 'disp', 'rim', 'envProj'];
  const resolve = (r) => {
    const p = {};
    for (const k of PKEYS) p[k] = k in r ? r[k] : params[k];
    return p;
  };

  let raf = 0;
  let frames = 0;
  let fpsT = performance.now();
  let fps = 0;
  let sized = false;   // 纹理是否已按画布尺寸分配（同画布重建实例时尺寸不变，不能凭尺寸跳过）
  let bgTexW = 0;
  let bgTexH = 0;

  function resize(targetW, targetH) {
    let w, h;
    if (targetW > 0 && targetH > 0) {
      w = Math.round(targetW);
      h = Math.round(targetH);
    } else {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.round(canvas.clientWidth * dpr);
      h = Math.round(canvas.clientHeight * dpr);
    }
    if (w <= 0 || h <= 0) return;
    if (sized && canvas.width === w && canvas.height === h) return;
    sized = true;
    canvas.width = w;
    canvas.height = h;
    bgDirty = true;
    const compList = compTexA ? [compTexA, compTexB] : [];
    // 纹理模式下 bgTex 的尺寸由外部喂的源决定，resize 不碰它
    if (!bgTexture) {
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      bgTexW = w;
      bgTexH = h;
    }
    for (const t of compList) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      // 重分配会作废 mip 链——若合成纹还挂着三线性滤波就成了「不完整纹理」
      //（采样恒返回黑）。回到基态 LINEAR，由 blurSource 需要时再建 mip/切滤波
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    // 磨砂柔纹全分辨率（半分辨率存在重建地板，σ 较小时模糊量受限）
    for (const t of [blurTexA, blurTexB]) {
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

  /**
   * 喂背景画面（纹理模式）：src 是任意 TexImageSource（canvas/ImageBitmap…），
   * 引擎翻转 y（源 y 向下 → gl_FragCoord 的 y 向上）后上传并建 mipmap。
   * 若调用方已在 2D 合成阶段完成翻转（opts.preflipped = true）且使用 { alpha: false } 画布，
   * 可跳过 UNPACK_FLIP_Y_WEBGL（避免 Chromium/ANGLE 回退 CPU 逐行翻转与反预乘）并复用 texSubImage2D。
   */
  let flipCanvas = null;
  function setBackground(src, uploadOpts) {
    if (!src) {
      // 回退着色器背景路径（解除纹理模式的单向闩锁）
      bgTexture = false;
      bgTexW = 0;
      bgTexH = 0;
      bgDirty = true;
      return;
    }
    bgTexture = true;
    const flipY = !(uploadOpts && uploadOpts.preflipped);
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    // UNPACK_FLIP_Y 对 ImageBitmap 按规范被静默忽略——原样拷进 2D canvas
    // 转成 flag 生效的源，翻转统一交给下方的 pixelStore（拷贝不镜像，翻转
    // 只发生一次）
    if (flipY && typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) {
      if (!flipCanvas) flipCanvas = document.createElement('canvas');
      flipCanvas.width = src.width;
      flipCanvas.height = src.height;
      flipCanvas.getContext('2d').drawImage(src, 0, 0);
      src = flipCanvas;
    }
    const srcW = src.width || src.videoWidth || 0;
    const srcH = src.height || src.videoHeight || 0;
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (srcW > 0 && srcH > 0 && srcW === bgTexW && srcH === bgTexH) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      bgTexW = srcW;
      bgTexH = srcH;
    }
    if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    bgDirty = false;
  }

  /** 绑定绘制目标 + 采样源（blurSource 改绑 FBO/viewport 后恢复用） */
  function bindTarget(dstFbo, srcTex) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
  }

  /** 铺底：src 纹理原样铺进目标，保住玻璃包围盒以外的画面 */
  function blit(srcTex, dstFbo) {
    bindTarget(dstFbo, srcTex);
    gl.useProgram(blitProg);
    gl.bindVertexArray(vao);
    gl.uniform1i(blitU.uBg, 0);
    gl.uniform2f(blitU.uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 磨砂预模糊：把 src 以高斯 σ=blur px 横纵两趟卷进柔纹（全分辨率——半格
   * 有 ~1px 的帐篷重建地板，σ 较小时模糊量受限；全格 σ=0.5 精度充分）。返回柔纹
   *（drawGlass 挂 TEXTURE1）；注意会改绑 FBO/viewport，调用方画玻璃前要
   * 重新绑定自己的目标。
   */
  function blurSource(srcTex, p, r) {
    // σ = max(blur, 0.5) px（CSS blur() 同口径）：blur=16 对应 σ=16，与
    // macOS 满档磨砂观感一致（实测标定 σ≈15.8）。参数语义：blur 即 σ
    const sigma = Math.max(p.blur, 0.5);
    // 预滤波靠 mip 盒滤（见 BLUR_FRAG）——σ>1 才用得上（预滤波 lod=log2σ），
    // 窄模糊档 lod=0，跳过 mipmap 重建。bgTex 自带 mipmap；层间合成纹理
    // 按需补建，min filter 同步切三线性（LINEAR 下 textureLod 恒读基级）
    if (srcTex !== bgTex && sigma > 1.0) {
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    // 有效区：采样点 = frag + inward·shift，朝内走但会**越过对边**（薄板 +
    // 大 dist 时），保守取 rect⊕dist；柔纹须盖住采样点 + RGSS 足迹（+6px）。
    // 横趟再外扩 3σ（纵趟核截断的读取范围）——两趟 scissor 分开设，横写大、
    // 纵写小，省掉 3σ 环带的重复填充
    const reachV = p.dist + 6;
    const reachH = reachV + sigma * 3 + 2;
    gl.useProgram(blurProg);
    gl.bindVertexArray(vao);
    gl.enable(gl.SCISSOR_TEST);
    gl.uniform1i(blurU.uBg, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);   // 解绑上一玻璃的柔纹——避免与输出目标同绑（反馈隐患）
    gl.activeTexture(gl.TEXTURE0);
    // 横：src → blurA（范围须含纵趟的核读取）
    gl.bindFramebuffer(gl.FRAMEBUFFER, blurFboA);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.scissor(
      Math.floor(r.x - r.w / 2 - reachH),
      Math.floor(r.y - r.h / 2 - reachH),
      Math.ceil(r.w + reachH * 2),
      Math.ceil(r.h + reachH * 2));
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform2f(blurU.uRes, canvas.width, canvas.height);
    gl.uniform2f(blurU.uSpacing, sigma / (2 * canvas.width), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 纵：blurA → blurB（范围 = 玻璃实际读取区）。两趟 uv 步进同口径
    //（σ/2 源像素折算）→ 各向同性
    gl.bindFramebuffer(gl.FRAMEBUFFER, blurFboB);
    gl.scissor(
      Math.floor(r.x - r.w / 2 - reachV),
      Math.floor(r.y - r.h / 2 - reachV),
      Math.ceil(r.w + reachV * 2),
      Math.ceil(r.h + reachV * 2));
    gl.bindTexture(gl.TEXTURE_2D, blurTexA);
    gl.uniform2f(blurU.uSpacing, 0, sigma / (2 * canvas.height));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    return blurTexB;
  }

  /** 一块玻璃的着色（要求 src 已绑在 TEXTURE0、目标已绑定、viewport 已设） */
  function drawGlass(r, p, premult, softTex) {
    // 绘制区 = 玻璃体 + 轮廓 AA 带（体外无任何可见输出——晕已退役）
    const reach = 2;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.floor(r.x - r.w / 2 - reach),
      Math.floor(r.y - r.h / 2 - reach),
      Math.ceil(r.w + reach * 2),
      Math.ceil(r.h + reach * 2));
    gl.useProgram(glassProg);
    gl.bindVertexArray(vao);
    gl.uniform1i(gU.uBg, 0);
    gl.uniform1i(gU.uSoft, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, softTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(gU.uRes, canvas.width, canvas.height);
    gl.uniform4f(gU.uRect, r.x, r.y, r.w / 2, r.h / 2);
    gl.uniform1f(gU.uRadius, p.radius);
    gl.uniform1f(gU.uBevel, p.bevel);
    gl.uniform1f(gU.uDist, p.dist);
    gl.uniform1f(gU.uFold, p.fold);
    gl.uniform1f(gU.uBend, p.bend);
    gl.uniform1f(gU.uDisp, p.disp);
    gl.uniform1f(gU.uRim, p.rim);
    gl.uniform1f(gU.uTint, p.tint);
    gl.uniform1f(gU.uEnvProj, p.envProj);
    gl.uniform1f(gU.uPremult, premult);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** 依赖半径：该玻璃的画面会被别处采到/糊进的范围（环境取色 + 磨砂核） */
  function dependReach(r) {
    return Math.max(
      r.dist ?? params.dist,
      (r.bevel ?? params.bevel) + 12,
      3 * Math.max(r.blur ?? params.blur, 0.5) + 12,
    );
  }

  /** 包围盒（含依赖半径）是否相交——相交才有层间折射的需求 */
  function bboxHit(a, b) {
    const ra = dependReach(a) + 2;
    const rb = dependReach(b) + 2;
    return Math.abs(a.x - b.x) * 2 < a.w + b.w + (ra + rb) * 2
      && Math.abs(a.y - b.y) * 2 < a.h + b.h + (ra + rb) * 2;
  }

  /** 渲一帧（外部驱动入口：接入方把它挂进自己的帧循环）；start() 的内部 rAF 也走这 */
  function render(now, targetW, targetH) {
    if (!Number.isFinite(now)) now = performance.now();   // 防 render() 裸调把 NaN 喂进 uTime
    resize(targetW, targetH);

    // pass 1：背景进纹理。纹理模式（setBackground）下由调用方负责；着色器模式下
    // 静态背景只在尺寸变化后重画（含 mipmap 重建，窄模糊档靠 LOD 采样），动画背景逐帧推 uTime
    if (!bgTexture && bgProg && (bgAnimated || bgDirty)) {
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

    // pass 2：合成，两档——
    // · 单目标叠画（默认；transparent / nested 关闭 / 包围盒互不相交时走这档）：
    //   铺底 + 各画各的小框，预乘混合让上层遮挡下层。
    //   transparent 模式不铺底（画布透明、真实页面透出），只画玻璃本体
    // · 逐层合成（nested 开启、非 transparent、包围盒相交）：自后向前，上层采样
    //   下层的合成结果——重叠处「隔玻璃看玻璃」；每层铺底+小框
    // 逐层合成只在「nested 开 + 存在包围盒相交」时启用——不相交走单目标
    // 叠画快路径（注意初值必须是 false：若初值已带 nested 条件，下面的
    // !needLayers 循环卫语句会把相交扫描整个短路掉）
    let needLayers = false;
    if (nested && !transparent) {
      for (let i = 0; i < rects.length && !needLayers; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          if (bboxHit(rects[i], rects[j])) { needLayers = true; break; }
        }
      }
    }

    if (rects.length === 0) {
      if (transparent) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        blit(bgTex, null);
      }
    } else if (!needLayers) {
      if (transparent) {
        // 透明三明治：画布不铺底，先清空再叠画——防止同帧二次 render 叠影
        bindTarget(null, null);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        blit(bgTex, null);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // 预乘 over
      bindTarget(null, bgTex);
      for (const r of rects) {
        const p = resolve(r);
        const soft = blurSource(bgTex, p, r);
        bindTarget(null, bgTex);   // blurSource 会改绑 FBO/viewport——恢复
        drawGlass(r, p, 1, soft);
      }
      gl.disable(gl.BLEND);
    } else {
      let srcTex = bgTex;
      for (let i = 0; i < rects.length; i++) {
        const last = i === rects.length - 1;
        const mid = i % 2 === 0;
        const dstFbo = last ? null : mid ? compFboA : compFboB;
        const p = resolve(rects[i]);
        blit(srcTex, dstFbo);
        const soft = blurSource(srcTex, p, rects[i]);
        bindTarget(dstFbo, srcTex);   // blurSource 会改绑 FBO/viewport——恢复
        drawGlass(rects[i], p, 0, soft);
        if (!last) srcTex = mid ? compTexA : compTexB;
      }
    }

    frames++;
    if (now - fpsT > 500) {
      fps = (frames * 1000) / (now - fpsT);
      frames = 0;
      fpsT = now;
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    render(now);
  }

  return {
    params,
    rects,
    /** 喂背景画面（纹理模式）：任意 TexImageSource，动画背景每帧调用 */
    setBackground,
    /** 外部驱动渲一帧（挂进自己的帧循环用它，配合 stop() 不开内部 rAF）。
     *  内部 rAF 运行期间调用会被忽略——避免双驱叠画/翻倍计 fps */
    render(now, targetW, targetH) {
      if (!raf) render(now, targetW, targetH);
    },
    /** 嵌套折射开关：开 = 重叠玻璃逐层合成互相折射；关 = 单目标叠画（更快） */
    get nested() { return nested; },
    set nested(v) { nested = !!v; },
    /** 兼容单面板用法：第一块面板的别名 */
    get rect() { return rects[0]; },
    get fps() { return fps; },
    start() { if (!raf) raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    dispose() {
      this.stop();
      for (const t of [bgTex, compTexA, compTexB, blurTexA, blurTexB]) if (t) gl.deleteTexture(t);
      for (const f of [bgFbo, compFboA, compFboB, blurFboA, blurFboB]) if (f) gl.deleteFramebuffer(f);
      gl.deleteProgram(bgProg);
      gl.deleteProgram(blitProg);
      gl.deleteProgram(glassProg);
      gl.deleteProgram(blurProg);
      gl.deleteVertexArray(vao);
    },
  };
}
