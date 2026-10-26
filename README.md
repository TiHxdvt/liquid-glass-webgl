<div align="center">

# liquid-glass-webgl

**液态玻璃 / liquid glass for WebGL2**

physically-based refraction · single-file · zero-dependency

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![WebGL2](https://img.shields.io/badge/WebGL2-%E2%9C%93-success)
![dependencies](https://img.shields.io/badge/dependencies-0-success)
![single file](https://img.shields.io/badge/single-file-informational)



<img src="docs/images/hero.gif" width="100%" alt="liquid-glass-webgl demo">

## Features

- **真实折射** — 斯涅尔定律驱动的位移场，不是滤镜近似；玻璃拖过色块时边缘环出现**倒像**
- **对折位移场** — 采样映射在环内带极小值（对折点），外侧半环倒序成像，对折线弯出缓 U
- **Schlick 菲涅尔** — 边缘各边天然比背景略亮，反光颜色取自周边环境而非写死的白
- **乳白玻璃** — 灰阶压高提低 + 彩度不对称扩张
- **Cauchy 色散** — R/G/B 采样距离微差
- **多块堆叠** — `rects` 数组自后向前合成；开 `nested` 则重叠处上层玻璃**折射下层玻璃**
  （光学嵌套），关则上层遮挡（更快）
- **单文件零依赖** — 一个 `.js`，无构建要求，支持 WebGL2 即可

## Gallery

### 与 macOS 液态玻璃对比

| macOS Liquid Glass | liquid-glass-webgl |
|:---:|:---:|
| <img src="docs/images/compare-macos.png" width="420" alt="macOS"> | <img src="docs/images/compare-ours.png" width="420" alt="ours"> |

### 细节

| 纯黑背景下的轮廓 | 对折线 | 边缘倒像环 |
|:---:|:---:|:---:|
| <img src="docs/images/bg-black.png" width="270" alt="black"> | <img src="docs/images/fold-closeup.png" width="270" alt="fold"> | <img src="docs/images/edge-closeup.png" width="270" alt="edge"> |

## Quick Start

```js
import { createLiquidGlass } from './liquid-glass-webgl.js';

// 全屏背景片元着色器（GLSL ES 3.0）——引擎不内置背景，渲进纹理后折射采样
const background = `#version 300 es
precision highp float;
uniform vec2 uRes;
out vec4 outColor;
void main() { outColor = vec4(gl_FragCoord.xy / uRes, 0.5, 1.0); }`;

const glass = createLiquidGlass(canvas, { background });
glass.start();
```

玻璃的位置、尺寸与光学参数逐帧生效：

```js
glass.rect.x = 480;            // 中心坐标（设备像素，y 向上）；rect 即 rects[0]
glass.params.radius = 55;      // 圆角
glass.params.dist = 50;        // 采样距离

glass.start(); glass.stop(); glass.dispose();
```

多块玻璃：数组顺序 = 堆叠顺序（自后向前）。每项可单独覆盖任意光学字段，
未给出的回落到全局 `params`：

```js
glass.rects.push({ x: 900, y: 400, w: 220, h: 220, radius: 110 });
glass.rects.push({ x: 500, y: 300, w: 360, h: 160, dist: 70 });  // 这块采样距离不同
```

重叠时两种合成：`nested: false`（默认）上层遮挡下层，成本与分散面板相同；
`nested: true`（或运行时 `glass.nested = true`）逐层合成，重叠处上层的倒像里
能看到下层玻璃被弯折——玻璃压玻璃的光学嵌套，多一层合成税。

## Parameters

| 参数 | 字段 | 默认 | 说明 |
|---|---|---:|---|
| 圆角 | `radius` | 55 | 圆角半径（px） |
| 边缘环宽 | `bevel` | 25 | 折射位移场的作用范围（px） |
| 采样距离 | `dist` | 50 | 边缘最大位移——玻璃拖入色块时「异色被拉进来」的距离 |
| 倒像陡度 | `fold` | 2.6 | 位移衰减幂次；>1 时场内出现对折点（倒像） |
| 软弯倍率 | `bend` | 3 | 折返点曲率半径的放大系数 |
| 玻璃下磨砂 | `blur` | 1 | 磨砂半径（px） |
| 乳白 | `milk` | 1 | 乳白强度（0 纯透明玻璃，1 出厂标定的乳白透过率） |
| 色散 | `disp` | 0.5 | R/G/B 采样距离微差 |
| 边缘反光 | `rim` | 0 | Schlick 高光强度 |
| 外缘羽化 | `feather` | 0.5 | 轮廓内外颜色过渡宽度（px） |
| 环境投影 | `envProj` | 0 | 边缘反光取周边背景色（0/1） |

## Demo

```bash
cd demo
python3 -m http.server 8000
# 打开 http://localhost:8000
```

3×3 测试卡（平色 / 网格 / 斑马 / 棋盘 / 光谱条）+ 全参数滑杆 + 拖拽移动玻璃。

## How It Works

**核心机制——对折位移场**：边缘环的采样映射是「显示深度 x → 采样深度 s(x)」，
s 从外缘的采样距离单调递减到内缘的原位，画面倒序成像（倒像）。把玻璃拖进
色块时「进去的部分显示色块外的颜色、越往里进异色越向边缘挤压拉伸」即由此
而来：异色带宽度由采样距离决定，收缩方向永远贴边。衰减够陡时 s 在环内出现
极小值（对折点）——外侧半环倒序，对折处条纹折返。折返顶点是二次曲率拱，
条纹在对折线两侧弯出缓 U、一阶连续会师。

- **几何** — 圆角矩形解析 SDF；方向场取加宽圆角的梯度（消角部中轴折痕），
  倒像场深度取真实边缘 SDF（等深轮廓与可见边缘同心）
- **折射** — `s(x) = x + 采样距离×(1−t)^倒像陡度`，外缘采样最远、内缘原位
- **外侧臂** — 四分之一椭圆弧（边界条件定形：v 半轴 = 采样距离−sMin、
  u 半轴 = 折线深度），内侧臂用曲率缩放保持顶点二次曲率
- **对折线光带** — 映射斜率 → 0 处的细线
- **边缘光** — Schlick 近似 + 环境取色 + 常量底光兜底
- **色散** — R/G/B 三通道各算位移（Cauchy 型 η(λ)）
- **乳白玻璃** — 灰阶响应 `0.748·c + 38/255`，彩度向亮度两侧不对称扩张
  （亮侧 ×1.36、暗侧 ×2.09）

<details>
<summary><b>调参注意（会调出异常的点）</b></summary>

- **软弯倍率**只作用于内侧臂，且必须用曲率缩放（g′(0)>0）。磨圆式软化
 （g′(0)=0）会把折返顶点拉成平顶 → 对折线变宽、顶点下图像被拉直
- **圆角**变化时轮廓必须保持同心等深。倒像场深度若误用加宽 SDF，圆角调到
  60-80 段会出现边缘折线、形状冻结
- **倒像陡度** ≤1、或 采样距离×陡度 ≤ 边缘环宽 时对折点消失，退化为纯单调
  映射（没有倒像）
- **外缘羽化**过窄（≲1px）黑白交界出像素台阶；过宽轮廓发虚
- 一切 `exp(-depth/k)` 型轮廓项必须钳在玻璃内（`max(depth,0)`）。玻璃外
  depth<0 会溢出为 Inf，`Inf×0=NaN` 把大片画面抹黑，黑区边界沿遮罩零线走，
  呈直边状假投影
- 轮廓遮罩的法线必须取真实边缘 SDF。取加宽 SDF 的方向场时弯角区法线偏掉，
  白黑两档互相染边
- 乳白系数是透过率表的响应，改系数即偏离该表

## License

[MIT](LICENSE) © 2026 HaodongWen
