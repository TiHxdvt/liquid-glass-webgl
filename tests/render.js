import { createLiquidGlass } from '../liquid-glass-webgl.js';

const canvas = document.querySelector('canvas');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
const out = document.getElementById('results');
const lines = [];
const w = 384, h = 256;
const background = `#version 300 es
precision highp float;
uniform vec2 uRes;
out vec4 color;
void main() {
  vec2 p = gl_FragCoord.xy;
  float grid = mod(floor(p.x / 3.0) + floor(p.y / 3.0), 2.0);
  color = vec4(vec2(p.x / uRes.x, p.y / uRes.y), grid, 1.0);
}`;
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pixels() {
  const result = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, result);
  assert(gl.getError() === gl.NO_ERROR, 'WebGL 错误');
  return result;
}

function equal(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function run() {
  assert(gl, '需要 WebGL2');
  const counts = {};
  for (const key of ['drawArrays', 'texImage2D', 'texSubImage2D', 'generateMipmap', 'createTexture']) {
    const fn = gl[key].bind(gl);
    counts[key] = 0;
    gl[key] = (...args) => { counts[key]++; return fn(...args); };
  }
  async function test(name, fn, opts = {}) {
    const glass = createLiquidGlass(canvas, { background, ...opts });
    try {
      await fn(glass);
      assert(gl.getError() === gl.NO_ERROR, 'WebGL 错误');
      lines.push('✓ ' + name);
    } finally { glass.dispose(); }
  }

  await test('外部小图 → 着色器背景，尺寸与像素完整恢复', g => {
    g.rects.length = 0;
    g.render(0, w, h);
    const original = pixels();
    const img = document.createElement('canvas');
    img.width = 16;
    img.height = 9;
    const ctx = img.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 16, 9);
    g.setBackground(img, { version: 1 });
    g.render(0, w, h);
    assert(pixels()[0] === 255, '外部背景上传失败');
    const mips = counts.generateMipmap;
    g.setBackground(img, { version: 1 });
    assert(counts.generateMipmap === mips, '相同内容版本重复上传');
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, 0, 16, 9);
    const subs = counts.texSubImage2D;
    g.setBackground(img);
    g.render(0, w, h);
    assert(pixels()[2] === 255 && counts.texSubImage2D === subs + 1, '可变 canvas 更新失败');
    g.setBackground(null);
    g.render(0, w, h);
    assert(equal(original, pixels()), '回退后图像尺寸或像素不一致');
  });

  await test('细棋盘的磨砂与对折线保持标定位置', g => {
    Object.assign(g.rect, { x: 170.25, y: 128.5, w: 170, h: 112, radius: 38 });
    g.params.tint = 0;
    const sigmas = [1.5, 2.5, 3.5, 4, 16];
    // 3791f02 的 RGBA8 参考采样。RG 坡度记录折射位置，B 棋盘记录磨砂与足迹采样。
    // 每行依次为 x、y、参考 R/G 和各 σ 的 B，容许两级舍入误差。
    const samples = [
      [87, 128, 76, 123, [122, 122, 123, 123, 123]],
      [92, 128, 73, 128, [124, 129, 128, 128, 128]],
      [101, 128, 70, 128, [127, 127, 128, 128, 128]],
      [109, 128, 72, 128, [131, 127, 128, 128, 128]],
      [118, 128, 77, 128, [122, 127, 128, 128, 128]],
      [106, 87, 76, 97, [122, 128, 128, 128, 128]],
      [97, 95, 73, 104, [125, 129, 128, 128, 128]],
      [169, 116, 113, 114, [121, 128, 128, 128, 128]],
    ];
    for (const [index, sigma] of sigmas.entries()) {
      g.params.blur = sigma;
      g.render(0, w, h);
      const frame = pixels();
      for (const [x, y, r, green, blue] of samples) {
        const offset = (y * w + x) * 4;
        const ok = [r, green, blue[index]].every((value, ch) => Math.abs(frame[offset + ch] - value) <= 2);
        assert(ok, '磨砂 σ=' + sigma + ' 在 (' + x + ',' + y + ') 超出像素容差');
      }
    }
  });

  await test('多面板磨砂复用，嵌套目标按需分配，下层改动传向上层', g => {
    const first = { x: 88, y: 112, w: 64, h: 50, blur: 2.5, dist: 12 };
    const second = { ...first, x: 275, blur: 4 };
    g.rects.splice(0, 1, first, second);
    g.nested = true;
    const created = counts.createTexture;
    g.render(0, w, h);
    assert(counts.createTexture - created === 3, '分离面板应分配两张局部结果与一张临时纹理');
    const draws = counts.drawArrays;
    g.params.tint = -1;
    g.render(0, w, h);
    assert(counts.drawArrays - draws === 3, '改玻色应仅铺底一次、合成两块玻璃');
    const beforeOverlap = counts.createTexture;
    second.x = first.x + 17;
    g.render(0, w, h);
    assert(counts.createTexture === beforeOverlap + 1, '两块重叠玻璃仅需一张层间纹理');
    const old = pixels();
    const oldDraws = counts.drawArrays;
    second.tint = 0.25;
    g.render(0, w, h);
    assert(counts.drawArrays - oldDraws === 2, '仅改顶层玻色应复用下层合成与磨砂');
    first.tint = 0.8;
    first.y -= 8;
    g.render(0, w, h);
    const moved = pixels();
    assert(!equal(old, moved), '下层改变未呈现');
    g.nested = false;
    g.render(0, w, h);
    g.nested = true;
    g.render(0, w, h);
    assert(equal(moved, pixels()), '缓存命中与清空重绘不一致');
  });

  await test('四层嵌套重排、移动和移除与重新分配后的画面一致', g => {
    g.nested = true;
    g.rects.length = 0;
    for (let i = 0; i < 4; i++) {
      g.rects.push({ x: 140 + i * 22, y: 135 - i * 11, w: 96, h: 78,
        radius: 13 + 2 * i, blur: 1.5 + i, tint: 0.3 * i, dist: 16 });
    }
    g.render(0, w, h);
    for (const edit of [
      () => { g.rects[0].tint = -1; },
      () => { g.rects.reverse(); },
      () => { g.rects[2].x -= 61.5; },
      () => { g.rects.splice(1, 1); },
    ]) {
      edit();
      g.render(0, w, h);
      const cached = pixels();
      g.render(0, w - 1, h);
      g.render(0, w, h);
      assert(equal(cached, pixels()), '层间合成或磨砂读到旧版本');
    }
  });

  await test('静态场景零重复绘制，直接修改原对象与显式失效均可唤醒', async g => {
    const r = { x: 80, y: 90, w: 40, h: 46 };
    g.rects.splice(0, 1, r);
    g.start();
    await nextFrame();
    await nextFrame();
    const draws = counts.drawArrays;
    await nextFrame();
    await nextFrame();
    assert(counts.drawArrays === draws, '静止时重复绘制');
    r.x++;
    await nextFrame();
    assert(counts.drawArrays > draws, '旧引用修改未唤醒');
    g.stop();
    g.start({ onDemand: true });
    await nextFrame();
    const demandDraws = counts.drawArrays;
    g.params.tint = -1;
    g.invalidate();
    g.invalidate();
    await nextFrame();
    assert(counts.drawArrays === demandDraws + 2, '显式失效应合并为一次铺底与一次合成');
    canvas.style.width = '400px';
    for (let i = 0; i < 6; i++) await nextFrame();
    assert(canvas.width === Math.round(400 * Math.min(devicePixelRatio, 2)), '休眠时调整 CSS 宽度未生效');
    canvas.style.removeProperty('width');
  });

  await test('启用按需调度时，uTime 动画仍逐帧绘制', async g => {
    g.start({ onDemand: true });
    await nextFrame();
    const draws = counts.drawArrays;
    await nextFrame();
    await nextFrame();
    assert(counts.drawArrays > draws, '动画背景停止');
  }, { background: background.replace('out vec4 color;', 'uniform float uTime; out vec4 color;')
    .replace('grid, 1.0', 'grid * abs(sin(uTime)), 1.0') });

  await test('WebGL 上下文恢复后保留外部背景、面板和玻色', async g => {
    const ext = gl.getExtension('WEBGL_lose_context');
    assert(ext, '需要 WEBGL_lose_context 扩展运行恢复测试');
    const img = document.createElement('canvas');
    img.width = img.height = 32;
    const ctx = img.getContext('2d');
    ctx.fillStyle = '#46ae92';
    ctx.fillRect(0, 0, 32, 32);
    g.setBackground(img);
    g.params.tint = -0.6;
    g.render(0, w, h);
    const saved = pixels();
    const lost = new Promise(resolve => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
    const restored = new Promise(resolve => canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
    ext.loseContext();
    await lost;
    await new Promise(resolve => setTimeout(resolve, 60));
    ext.restoreContext();
    await restored;
    g.render(0, w, h);
    assert(equal(saved, pixels()), '上下文恢复的输出不一致');
  });
}

window.regression = run().then(() => {
  out.textContent = lines.join('\n');
  return lines;
}).catch(err => {
  out.textContent = [...lines, '✗ ' + err.stack].join('\n');
  throw err;
});
