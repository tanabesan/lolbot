// ============================================================================
// convert.js (CommonJSバージョン)
// ・入力画像を強制的に指定サイズにリサイズ（NN補間）
// ・1px＝1ブロックとして出力
// ・id, blockId, textureId, name は引数またはデフォルト値を使用
// ============================================================================

// 'import' を 'require' に変更
const Jimp     = require('jimp');
const quantize = require('quantize');
const minimist = require('minimist');
const fs       = require('fs/promises');
const path     = require('path');

// ----------------------------------------------------------------------------
// 定数として上限を定義
// ----------------------------------------------------------------------------
const MAX_COLORS = 50;
const MAX_SIZE   = 256;

// ----------------------------------------------------------------------------
// CLI 引数定義
// ----------------------------------------------------------------------------
const argv = minimist(process.argv.slice(2), {
  string : ['input', 'output', 'baseName'],
  integer: [
    'maxColors', 'startId', 'blockId', 'textureId',
    'width', 'height'
  ],
  alias: {
    i: 'input',     o: 'output',
    c: 'maxColors',
    s: 'startId',   b: 'blockId',
    x: 'textureId', n: 'baseName',
    w: 'width',     h: 'height'
  },
  default: {
    startId:   1000,
    blockId:   346,
    textureId: 100,
    baseName:  'art Cube',
  }
});

if (!argv.input || !argv.output) {
  console.error('Usage: node convert.js --input <in.png> --output <out.glol> [--width W] [--height H] [--maxColors N]');
  process.exit(1);
}

// ----------------------------------------------------------------------------
// 画像→.glol 変換メイン
// ----------------------------------------------------------------------------
async function convertImageToGlol(inputPath, outputPath, opts) {
  // 入力ファイル存在チェック
  try {
    await fs.access(inputPath);
  } catch {
    console.error(`❌ 入力ファイルが見つかりません: ${inputPath}`);
    process.exit(1);
  }

  // 1) 画像読み込み
  const image = await Jimp.read(inputPath);

  // 2) 強制リサイズ：引数で指定されたサイズ（Nearest Neighbor）
  image.resize(opts.width, opts.height, Jimp.RESIZE_NEAREST_NEIGHBOR);

  console.log(`Resized → ${opts.width}×${opts.height}`);

  // 3) 全ピクセル色収集（透明は無視）
  const pixels = [];
  image.scan(0, 0, opts.width, opts.height, function(x, y, idx) {
    const alpha = this.bitmap.data[idx + 3];
    if (alpha === 0) return;
    pixels.push([
      this.bitmap.data[idx + 0],
      this.bitmap.data[idx + 1],
      this.bitmap.data[idx + 2]
    ]);
  });

  // 4) パレット量子化（出力上は色番のみ利用）
  const cmap    = quantize(pixels, opts.maxColors);
  const palette = cmap.palette();

  // 5) ブロック & グループ生成
  const blocks   = [];
  const groupDot = [];
  let idCounter  = opts.startId;

  image.scan(0, 0, opts.width, opts.height, function(x, y, idx) {
    const alpha = this.bitmap.data[idx + 3];
    if (alpha === 0) return;

    // 最近傍パレット色インデックス
    const r = this.bitmap.data[idx + 0];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    let bestIdx = 0, bestDist = Infinity;
    palette.forEach((prgb, i) => {
      const d = (r - prgb[0])**2
              + (g - prgb[1])**2
              + (b - prgb[2])**2;
      if (d < bestDist) {
        bestDist = d;
        bestIdx  = i;
      }
    });

    blocks.push({
      id:        idCounter,
      blockId:   opts.blockId,
      name:      opts.baseName,
      textureId: opts.textureId,
      tintColor: ((palette[bestIdx][0] << 16)
                | (palette[bestIdx][1] << 8)
                |  palette[bestIdx][2]),
      position: {
        x: (opts.height - 1 - x) * 0.1,
        y: (opts.height - 1 - y) * 0.1,
        z: 0
      },
      scale: {
        x: 0.01,
        y: 0.01,
        z: 0.01
      }
    });

    groupDot.push(idCounter);
    idCounter++;
  });

  // 6) .glol 組み立て
  const glol = {
    version: 1,
    blocks,
    groups: { dot: groupDot }
  };

  // 7) 書き出し
  const absoluteOut = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absoluteOut), { recursive: true });
  await fs.writeFile(absoluteOut, JSON.stringify(glol, null, 2), 'utf-8');
  console.log(`✔ .glol created at: ${absoluteOut}`);
}

// ----------------------------------------------------------------------------
// 実行
// ----------------------------------------------------------------------------
(async () => {
  try {
    // ▼▼▼【修正点】上限チェックを追加 ▼▼▼
    const opts = {
      maxColors:  Math.min(argv.maxColors || MAX_COLORS, MAX_COLORS),
      startId:    argv.startId,
      blockId:    argv.blockId,
      textureId:  argv.textureId,
      baseName:   argv.baseName,
      width:      Math.min(argv.width  || MAX_SIZE, MAX_SIZE),
      height:     Math.min(argv.height || MAX_SIZE, MAX_SIZE)
    };

    // コマンドライン引数が指定されていない場合は、上限値をデフォルトとして使用
    if (!argv.maxColors) opts.maxColors = MAX_COLORS;
    if (!argv.width)     opts.width     = MAX_SIZE;
    if (!argv.height)    opts.height    = MAX_SIZE;
    // ▲▲▲【修正点】ここまで ▲▲▲

    await convertImageToGlol(
      argv.input,
      argv.output,
      opts
    );
  } catch (e) {
      console.error('❌ Conversion error:', e);
      process.exit(1);
  }
})();