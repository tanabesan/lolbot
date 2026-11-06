// YouTubeチャンネルの指定を解決する共通処理
// 受け付ける形式: UC...のチャンネルID / @ハンドル / youtube.comのチャンネルURL
const axios = require('axios');

const ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;

function parseInput(raw) {
  const text = String(raw || '').trim();
  if (ID_RE.test(text)) return { id: text };
  const url = text.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/i);
  if (url) return { id: url[1] };
  const h = text.match(/(?:youtube\.com\/)?(@[A-Za-z0-9._-]+)/i);
  if (h) return { handle: h[1] };
  return null;
}

// 戻り値: { id, title } / 見つからない・形式不正は null
async function resolveYoutubeChannel(raw) {
  const parsed = parseInput(raw);
  if (!parsed) return null;
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return parsed.id ? { id: parsed.id, title: null } : null; // APIキーなしならIDのみ受け付ける

  const params = { part: 'snippet', key };
  if (parsed.id) params.id = parsed.id; else params.forHandle = parsed.handle;
  const res = await axios.get('https://www.googleapis.com/youtube/v3/channels', { params, timeout: 10000 });
  const item = res.data.items && res.data.items[0];
  return item ? { id: item.id, title: item.snippet.title } : null;
}

module.exports = { resolveYoutubeChannel, ID_RE };