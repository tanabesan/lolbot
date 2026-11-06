// ============================================================================
// convert.js — 画像 → .glol 変換（Solid Pane 敷き詰め・ラン結合による最適化版）
// IMAGE → GLOL (template.html) のアルゴリズムをNode.jsに移植したもの
//   1. 画像をグリッドサイズへニアレストネイバーで縮小
//   2. 行ごとに「同色の横ラン」を検出
//   3. 同じ列位置・幅・色の横ランが縦に続く場合は1つの大きいブロックに結合
// 使い方:
//   node convert.js -i in.png -o out.glol [-w 32] [-h 32] [--saturation 1] [--brightness 1]
//                   [--keepTransparent] [-n グループ名] [-c 最大色数(省略可・減色するとブロック数が減る)]
// ============================================================================
const Jimp     = require('jimp');
const quantize = require('quantize');
const minimist = require('minimist');
const fs       = require('fs/promises');
const path     = require('path');

const BLOCK_ID = 500;
const BLOCK_NAME = 'Solid Pane';
const SPACING = 1.0;
const DEFAULT_QUATERNION = { x: 0, y: -0.7071067811865475, z: 0, w: 0.7071067811865476 };
const MAX_SIZE = 256;

const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));
function adjustColor(r, g, b, saturation, brightness) {
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  r = gray + (r - gray) * saturation;
  g = gray + (g - gray) * saturation;
  b = gray + (b - gray) * saturation;
  return [clamp255(r * brightness), clamp255(g * brightness), clamp255(b * brightness)];
}

/**
 * @param {string|Buffer} input 画像のパスまたはBuffer
 * @param {object} opts { width, height, groupName, saturation, brightness, keepTransparent, maxColors }
 * @returns {Promise<{glol: object, width: number, height: number, blockCount: number}>}
 */
async function convertImageToGlol(input, opts = {}) {
  const image = await Jimp.read(input);
  const srcW = image.bitmap.width, srcH = image.bitmap.height;
  const aspect = srcW / srcH;

  // 幅・高さ: 片方だけなら縦横比を維持、両方なければ幅32
  let gw = opts.width, gh = opts.height;
  if (!gw && !gh) gw = 32;
  if (gw && !gh) gh = Math.max(1, Math.round(gw / aspect));
  if (gh && !gw) gw = Math.max(1, Math.round(gh * aspect));
  gw = Math.min(MAX_SIZE, Math.max(1, Math.floor(gw)));
  gh = Math.min(MAX_SIZE, Math.max(1, Math.floor(gh)));

  const groupName = opts.groupName || 'Converted';
  const saturation = opts.saturation ?? 1;
  const brightness = opts.brightness ?? 1;
  const keepTransparent = !!opts.keepTransparent;

  image.resize(gw, gh, Jimp.RESIZE_NEAREST_NEIGHBOR);
  const data = image.bitmap.data;

  // 色の前処理（彩度・明度）。任意で減色してラン結合しやすくする
  const rgb = new Array(gw * gh);
  const solid = [];
  for (let i = 0; i < gw * gh; i++) {
    const a = data[i * 4 + 3];
    if (!keepTransparent && a < 10) { rgb[i] = null; continue; }
    rgb[i] = adjustColor(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], saturation, brightness);
    solid.push(rgb[i]);
  }
  let palette = null;
  if (opts.maxColors && opts.maxColors >= 2 && solid.length > 0) {
    const cmap = quantize(solid, Math.min(opts.maxColors, 256));
    if (cmap) {
      palette = cmap;
      for (let i = 0; i < rgb.length; i++) if (rgb[i]) rgb[i] = cmap.map(rgb[i]);
    }
  }
  const tintAt = (col, row) => {
    const c = rgb[row * gw + col];
    return c ? (c[0] << 16) + (c[1] << 8) + c[2] : null;
  };

  // 1st pass: 各行で同色の横ラン
  const rowRuns = [];
  for (let row = 0; row < gh; row++) {
    const runs = [];
    let col = 0;
    while (col < gw) {
      const tint = tintAt(col, row);
      if (tint === null) { col++; continue; }
      let len = 1;
      while (col + len < gw && tintAt(col + len, row) === tint) len++;
      runs.push([col, len, tint]);
      col += len;
    }
    rowRuns.push(runs);
  }

  // 2nd pass: 同じ列・幅・色の横ランが縦に続けば1ブロックに結合
  const blocks = [];
  const ids = [];
  let nextId = 1;
  const open = new Map();
  const flush = (key, info) => {
    const [colStart, runLen, tint] = key.split(',').map(Number);
    const { startRow, height } = info;
    const bottomRow = startRow + height - 1;
    const block = {
      id: nextId,
      blockId: BLOCK_ID,
      name: BLOCK_NAME,
      type: 'static',
      position: { x: colStart * SPACING + (runLen - 1) * SPACING / 2, y: -0.5 - bottomRow * SPACING, z: 0 },
      quaternion: { ...DEFAULT_QUATERNION },
      tintColor: tint
    };
    if (runLen > 1 || height > 1) block.scale = { x: 1, y: height, z: runLen };
    blocks.push(block);
    ids.push(nextId++);
  };
  for (let row = 0; row < gh; row++) {
    const cur = new Set(rowRuns[row].map(r => r.join(',')));
    for (const key of Array.from(open.keys())) {
      if (!cur.has(key)) { flush(key, open.get(key)); open.delete(key); }
    }
    for (const r of rowRuns[row]) {
      const key = r.join(',');
      if (open.has(key)) open.get(key).height++;
      else open.set(key, { startRow: row, height: 1 });
    }
  }
  for (const [key, info] of open) flush(key, info);

  return {
    glol: { blocks, groups: { [groupName]: ids }, version: 3 },
    width: gw, height: gh, blockCount: blocks.length
  };
}

module.exports = { convertImageToGlol };

// ---- CLI ----
if (require.main === module) {
  const argv = minimist(process.argv.slice(2), {
    string: ['input', 'output', 'name'],
    boolean: ['keepTransparent'],
    alias: { i: 'input', o: 'output', w: 'width', h: 'height', n: 'name', c: 'maxColors' }
  });
  if (!argv.input || !argv.output) {
    console.error('Usage: node convert.js -i <in.png> -o <out.glol> [-w W] [-h H] [--saturation 1] [--brightness 1] [--keepTransparent] [-n name] [-c maxColors]');
    process.exit(1);
  }
  (async () => {
    try {
      const r = await convertImageToGlol(argv.input, {
        width: argv.width, height: argv.height, groupName: argv.name,
        saturation: argv.saturation, brightness: argv.brightness,
        keepTransparent: argv.keepTransparent, maxColors: argv.maxColors
      });
      const out = path.resolve(argv.output);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, JSON.stringify(r.glol), 'utf-8');
      console.log(`✔ ${r.width}×${r.height} → ${r.blockCount} blocks: ${out}`);
    } catch (e) {
      console.error('❌ Conversion error:', e);
      process.exit(1);
    }
  })();
}