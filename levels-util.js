// コース一覧の取得・検索（/level コマンド用）
const axios = require('axios');

const TYPE_TAB = { normal: 1, hardcore: 4 };            // level-list の t パラメータ
const PLAY_URL_BASE = 'https://lolbeans.io/level/';
const CACHE_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 15;                                  // 1回の取得で叩くAPIの上限回数
const PAGE_SIZE = 50;

const EMOJI = {
  0: '<:sandbox:1437504794557153430>',
  1: '<:timed:1437504792451747901>',
  2: '<:competitive:1437504797547696188>',
  3: '<:elimination:1437504795899330560>'
};
const TYPE_NAME = { 0: 'サンドボックス', 1: 'タイムレース', 2: '対戦レース', 3: 'エリミネーション' };
const typeLabel = t => `${EMOJI[t] || '❓'} ${TYPE_NAME[t] || '不明'}`;

// levelId → shortId（index.cjs と同じ変換）
const Ts = 'CMWXZEPANBTHSYVFGKJDRU';
function levelIdToShortId(e) {
  let t = 5 * e, n = '';
  for (; 0 < t;) { const i = t % Ts.length; n = Ts.charAt(i) + n; t = Math.floor(t / Ts.length); }
  while (n.length < 5) n = Ts.charAt(0) + n;
  return n;
}
const playUrl = levelId => `${PLAY_URL_BASE}${levelIdToShortId(Number(levelId))}`;
const thumbUrl = levelId => `https://lolbeans.io/ui/level-thumbnails/${levelId}.png`;

const fetchPage = async (tab, i, n) => {
  const res = await axios.get(`https://s.lolbeans.io/level-list?i=${i}&t=${tab}&n=${n}&m`, { timeout: 10000 });
  return Array.isArray(res.data && res.data.l) ? res.data.l : [];
};

// 一覧の続きの取り方（i が「件数のオフセット」か「ページ番号」か）を自動判定しながら取得する
const loadAll = async (tab) => {
  const seen = new Set();
  const out = [];
  const add = (page) => {
    let fresh = 0;
    for (const l of page) { const id = String(l.levelId); if (!seen.has(id)) { seen.add(id); out.push(l); fresh++; } }
    return fresh;
  };

  const first = await fetchPage(tab, 0, PAGE_SIZE);
  add(first);
  if (first.length === 0) return out;
  const size = first.length;
  let requests = 1;

  // 続きの取得方法を判定: まずオフセット(i=件数)を試し、新しいコースが来なければページ番号(i=1)を試す
  let mode = null;
  const probeOffset = await fetchPage(tab, size, PAGE_SIZE); requests++;
  if (add(probeOffset) > 0) mode = 'offset';
  else {
    const probePage = await fetchPage(tab, 1, PAGE_SIZE); requests++;
    if (add(probePage) > 0) mode = 'page';
  }
  if (!mode) return out;

  let pageNo = mode === 'page' ? 2 : 0;
  while (requests < MAX_REQUESTS) {
    const i = mode === 'offset' ? out.length : pageNo++;
    const page = await fetchPage(tab, i, PAGE_SIZE); requests++;
    if (add(page) === 0) break;
  }
  return out;
};

const cache = {};
const getLevels = async (typeKey) => {
  const tab = TYPE_TAB[typeKey] || 1;
  const c = cache[tab];
  if (c && Date.now() - c.at < CACHE_MS) return c.levels;
  const levels = await loadAll(tab);
  if (levels.length > 0) cache[tab] = { at: Date.now(), levels };
  return levels;
};

const norm = s => String(s || '').normalize('NFKC').toLowerCase();
const searchLevels = (levels, keyword) => {
  const k = norm(keyword).trim();
  if (!k) return [];
  return levels.filter(l => norm(l.name).includes(k) || norm(l.author).includes(k) || norm(l.description).includes(k));
};

module.exports = { getLevels, searchLevels, typeLabel, playUrl, thumbUrl, loadAll, fetchPage };