require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client, Collection, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');

// Discordトークンが設定されていない場合は終了
if (!process.env.DISCORD_TOKEN) {
    console.error('❌ 環境変数 DISCORD_TOKEN が設定されていません。 / ❌ The environment variable DISCORD_TOKEN is not set.');
    process.exit(1);
}

const API_URL_NORMAL   = "https://s.lolbeans.io/level-list?i=0&t=1&n=10&m"; // 通常 New 欄
const API_URL_HARDCORE = "https://s.lolbeans.io/level-list?i=0&t=4&n=10&m"; // Hardcore 欄
const CHECK_INTERVAL = 10 * 60 * 1000; // 10分
const PLAY_URL_BASE = "https://lolbeans.io/level/";

// ─── YouTube 新着検知 ───
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
// 外部Webhook専用の監視対象（Discordチャンネルへの登録とは無関係、.envで固定管理）
const EXTERNAL_YOUTUBE_CHANNEL_IDS = (process.env.EXTERNAL_YOUTUBE_CHANNEL_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0);

// ─── levelId → shortId 変換 ───
const Ts = 'CMWXZEPANBTHSYVFGKJDRU';
function levelIdToShortId(e) {
  let t = 5 * e, n = '';
  for (; 0 < t;) {
    var i = t % Ts.length;
    n = Ts.charAt(i) + n;
    t = Math.floor(t / Ts.length);
  }
  while (n.length < 5) n = Ts.charAt(0) + n;
  return n;
}
function levelIdToPlayUrl(levelId) {
  return `${PLAY_URL_BASE}${levelIdToShortId(Number(levelId))}`;
}

// ─── MongoDB スキーマ定義 ───
const SubscriptionSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  channelId: { type: String, required: true },
  roleId:    { type: String, default: null }
});
const LastLevelSchema = new mongoose.Schema({
  levelId: { type: String, unique: true }
});
// Hardcore用に別コレクション
const LastHardcoreLevelSchema = new mongoose.Schema({
  levelId: { type: String, unique: true }
});

// YouTube: どのDiscordチャンネルに、どのYouTubeチャンネルの通知を送るか
const YoutubeSubscriptionSchema = new mongoose.Schema({
  guildId:          { type: String, required: true },
  channelId:        { type: String, required: true }, // Discordの通知先チャンネル
  youtubeChannelId: { type: String, required: true },  // 監視対象のYouTubeチャンネルID (UC...)
  title:            { type: String, default: null }     // 表示用のチャンネル名
});
// YouTube: 各YouTubeチャンネルごとに最後に検知した動画IDを保存
const LastYoutubeVideoSchema = new mongoose.Schema({
  youtubeChannelId: { type: String, unique: true },
  videoId:          { type: String },
  publishedAt:      { type: Date, default: null }
});

const Subscription       = mongoose.model('Subscription',      SubscriptionSchema);
const LastLevel          = mongoose.model('LastLevel',          LastLevelSchema);
const LastHardcoreLevel  = mongoose.model('LastHardcoreLevel',  LastHardcoreLevelSchema);
const YoutubeSubscription = mongoose.model('YoutubeSubscription', YoutubeSubscriptionSchema);
const LastYoutubeVideo    = mongoose.model('LastYoutubeVideo',    LastYoutubeVideoSchema);

// ─── Client 初期化 ───
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
client.commands = new Collection();
const TOKEN = process.env.DISCORD_TOKEN;

// ─── コマンド読み込み ───
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      try {
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
          client.commands.set(command.data.name, command);
        } else {
          console.log(`[警告] ${filePath} に必要な "data" または "execute" プロパティがありません。`);
        }
      } catch (error) {
          console.error(`コマンドファイルの読み込み中にエラーが発生しました ${filePath}:`, error);
      }
    }
} else {
    console.warn('[警告] commands ディレクトリが見つかりませんでした。');
}

// ─── 絵文字・レベルタイプ定義 ───
const CUSTOM_EMOJIS = {
  0: { name: 'sandbox',     id: '1437504794557153430' },
  1: { name: 'timed',       id: '1437504792451747901' },
  2: { name: 'competitive', id: '1437504797547696188' },
  3: { name: 'elimination', id: '1437504795899330560' }
};

const LEVEL_TYPES = {
  0: `<:${CUSTOM_EMOJIS[0].name}:${CUSTOM_EMOJIS[0].id}> サンドボックス (Sandbox)`,
  1: `<:${CUSTOM_EMOJIS[1].name}:${CUSTOM_EMOJIS[1].id}> タイムレース (Timed Race)`,
  2: `<:${CUSTOM_EMOJIS[2].name}:${CUSTOM_EMOJIS[2].id}> 対戦レース (Competitive Race)`,
  3: `<:${CUSTOM_EMOJIS[3].name}:${CUSTOM_EMOJIS[3].id}> エリミネーション (Elimination)`
};

const LEVEL_TYPES_TEXT = {
  0: "サンドボックス (Sandbox)",
  1: "タイムレース (Timed Race)",
  2: "対戦レース (Competitive Race)",
  3: "エリミネーション (Elimination)"
};

// ─── 新着判定の共通処理 ───
// ・初回（DBが空）は基準を保存するだけで通知しない
// ・一覧の先頭から既知のコースに当たるまでを新着とする（最新が削除されて繰り上がった古いコースは通知しない）
// ・保存済みIDは削除せず蓄積する（直近300件まで）ので、削除されても再通知されない
const processLevels = async (Model, currentLevels, label, isHardcore) => {
  const known = await Model.find({});
  const currentIds = currentLevels.map(l => l.levelId.toString());

  if (known.length === 0) {
    await Model.insertMany(currentIds.map(id => ({ levelId: id })), { ordered: false });
    console.log(`✔ 【${label}】初回起動のため基準を保存しました（通知なし）。`);
    return;
  }

  const knownSet = new Set(known.map(l => l.levelId));

  // 一覧は新しい順。先頭から「既知のコース」に当たるまでが本当の新着。
  // 既知のコースより後ろに現れた未知のコースは、最新コースが削除されて繰り上がった古いコースなので通知しない。
  // （levelIdの大小では判定しない：承認順などでIDが前後するコースを見逃すため）
  const newLevels = [];
  const promoted = [];
  let hitKnown = false;
  for (const l of currentLevels) {
    const id = l.levelId.toString();
    if (knownSet.has(id)) { hitKnown = true; continue; }
    (hitKnown ? promoted : newLevels).push(l);
  }
  if (promoted.length > 0) {
    console.log(`ℹ️ 【${label}】繰り上がり扱いで通知をスキップ: ${promoted.map(l => l.levelId).join(', ')}`);
  }

  // 通知前にDBへ記録（途中で落ちても再通知しない）
  const toStore = currentIds.filter(id => !knownSet.has(id));
  if (toStore.length > 0) {
    await Model.insertMany(toStore.map(id => ({ levelId: id })), { ordered: false }).catch(e => {
      console.warn(`【${label}】ID保存で警告:`, e.message);
    });
  }

  if (newLevels.length > 0) {
    console.log(`✅ 【${label}】${newLevels.length} 個のコースを検知！`);
    await notifyNewLevels(newLevels, isHardcore);
    await notifyExternalWebhook(newLevels, isHardcore);
  } else {
    console.log(`✔ 【${label}】新規コースは検知されませんでした。`);
  }

  // 古いIDの掃除（最新300件だけ残す）
  const total = known.length + toStore.length;
  if (total > 300) {
    const all = (await Model.find({})).map(d => d.levelId).sort((a, b) => Number(b) - Number(a));
    await Model.deleteMany({ levelId: { $in: all.slice(300) } });
  }
};

// ─── 通常コース：新規検知・通知 ───
const checkNewLevels = async () => {
  console.log("【通常】新しいレベルをチェック中...");
  try {
    const response = await axios.get(API_URL_NORMAL, { timeout: 10000 });
    const currentLevels = response.data.l;

    if (!Array.isArray(currentLevels)) {
      console.error('APIから予期しないデータを受信:', JSON.stringify(response.data, null, 2));
      return;
    }

    await processLevels(LastLevel, currentLevels, '通常', false);
  } catch (error) {
    console.error('❌ 【通常】レベルチェック中にエラー:', error && error.message ? error.message : error);
  }
};

// ─── Hardcoreコース：新規検知・通知 ───
const checkNewHardcoreLevels = async () => {
  console.log("【Hardcore】新しいレベルをチェック中...");
  try {
    const response = await axios.get(API_URL_HARDCORE, { timeout: 10000 });
    const currentLevels = response.data.l;

    if (!Array.isArray(currentLevels)) {
      console.error('【Hardcore】APIから予期しないデータを受信:', JSON.stringify(response.data, null, 2));
      return;
    }

    await processLevels(LastHardcoreLevel, currentLevels, 'Hardcore', true);
  } catch (error) {
    console.error('❌ 【Hardcore】レベルチェック中にエラー:', error && error.message ? error.message : error);
  }
};

// ─── 両方まとめて実行（アクティビティ表示も管理）───
const checkAll = async () => {
  client.user.setActivity({ name: "レベルを検知中... 📡", type: 3 });

  await checkNewLevels();
  await checkNewHardcoreLevels();
  await checkNewYoutubeVideos();
  await checkChangelog(); // 更新通知（10分ごとに、通知すべきものがあるか確認）

  const serverCount = client.guilds.cache.size;
  client.user.setActivity({
    name: `${serverCount} サーバーを監視中...`,
    type: 3,
  });
};

// ─── 共通: 文字列を切り詰め ───
const clip = (str, n) => (str && str.length > n) ? str.slice(0, n - 1) + '…' : (str || '');

// ─── Discord通知（複数コースでも1メッセージにまとめる）───
const notifyNewLevels = async (newLevels, isHardcore) => {
  const allSubs = await Subscription.find({});
  const sorted = newLevels.slice().sort((a, b) => (Number(a.levelId) || 0) - (Number(b.levelId) || 0)).slice(-10); // embedは最大10個

  const embeds = sorted.map(level => {
    const courseType = LEVEL_TYPES[level.type] || '❓ 不明 (Unknown)';
    const descLines = [
      `**${clip(level.name || '名前なし', 100)}**`,
      `${courseType} ｜ \`${level.author || '不明'}\``,
    ];
    if (level.description) descLines.push(clip(level.description, 300));
    const embed = new EmbedBuilder()
      .setTitle(isHardcore
        ? "🔥 Hardcoreコースが追加されました！"
        : "新しいコースが追加されました！ 🌟")
      .setDescription(descLines.join('\n'))
      .setColor(isHardcore ? 0xFF4500 : 0x00FF00)
      .setThumbnail(`https://lolbeans.io/ui/level-thumbnails/${level.levelId}.png`);
    if (isHardcore) embed.setFooter({ text: "💀 Hardcore" });
    return embed;
  });

  // プレイボタン（1個なら「▶ プレイ」、複数ならコース名付き。1行5個まで）
  const buttons = sorted.map(level => new ButtonBuilder()
    .setLabel(sorted.length === 1 ? '▶ プレイ' : clip(`▶ ${level.name || level.levelId}`, 80))
    .setStyle(ButtonStyle.Link)
    .setURL(levelIdToPlayUrl(level.levelId)));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }

  for (const settings of allSubs) {
    try {
      const channel = await client.channels.fetch(settings.channelId);
      if (!channel) continue;

      const roleMention = settings.roleId ? `<@&${settings.roleId}> ` : "";
      const plural = sorted.length > 1 ? `（${sorted.length}件）` : '';
      const contentText = isHardcore
        ? `${roleMention}🔥 Hardcoreの新規コースのお知らせです！${plural}`
        : `${roleMention}新規コースのお知らせです！${plural}`;

      await channel.send({ content: contentText, embeds, components: rows });
    } catch (error) {
      console.error(`サーバーID ${settings.guildId} への通知送信中にエラー:`, error && error.message ? error.message : error);
    }
  }
};

// ─── 外部Webhook送信（2000文字を超える場合のみ分割）───
const getWebhookUrls = () => (process.env.EXTERNAL_WEBHOOK_URL || '')
  .split(',').map(u => u.trim()).filter(u => u.length > 0);

const postExternalWebhook = async (blocks, tag) => {
  const urls = getWebhookUrls();
  if (urls.length === 0) {
    console.warn("⚠️ EXTERNAL_WEBHOOK_URL が .env に設定されていないため、外部送信をスキップします。");
    return;
  }
  // ブロック単位で2000文字以内にまとめる
  const chunks = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && (cur.length + b.length + 1) > 1900) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + b;
  }
  if (cur) chunks.push(cur);

  for (const content of chunks) {
    for (const url of urls) {
      try {
        await axios.post(url, { username: "ろるー@ディスコボット", content });
        console.log(`✅ 外部Webhook送信成功 (${tag}, ${url})`);
      } catch (error) {
        console.error(`❌ 外部Webhook送信失敗 (${tag}, ${url}):`, error.message);
      }
    }
  }
};

// ─── 外部Webhook通知（コース）───
const notifyExternalWebhook = async (newLevels, isHardcore) => {
  const sorted = newLevels.slice().sort((a, b) => (Number(a.levelId) || 0) - (Number(b.levelId) || 0));
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const plural = sorted.length > 1 ? `（${sorted.length}件）` : '';
  const header = isHardcore
    ? `**🔥 新規Hardcoreコミュニティレベルが追加されました！${plural}**`
    : `**新規コミュニティレベルが追加されました！${plural}**`;

  const blocks = [header, "----------------------------------", `検知時刻: ${now}`, ""];
  for (const level of sorted) {
    const lines = [
      `**${level.name || '名前なし'}**`,
      `${LEVEL_TYPES_TEXT[level.type] || '不明 (Unknown)'} | ${level.author || '不明'}`,
    ];
    if (level.description) lines.push(clip(level.description, 200));
    lines.push(`▶ ${levelIdToPlayUrl(level.levelId)}`, "");
    blocks.push(lines.join('\n'));
  }
  await postExternalWebhook(blocks, isHardcore ? 'Hardcore' : '通常');
};

// ─── YouTube（通常動画・プレミア公開・ライブ配信に対応）───
// 動画ごとに状態（none / upcoming / live）を記録し、
//   ・新しく現れた動画（予定・配信中も含む）を通知
//   ・「予定」だった動画が「配信中」になったら、もう一度通知
// 種類の判定: liveStreamingDetails が無ければ通常動画、あれば duration が 0 ならライブ配信・0 でなければプレミア公開
const YoutubeVideoStateSchema = new mongoose.Schema({
  youtubeChannelId: { type: String, required: true },
  videoId:          { type: String, required: true },
  state:            { type: String, default: 'none' },   // none | upcoming | live
  publishedAt:      { type: Date, default: null }
});
YoutubeVideoStateSchema.index({ youtubeChannelId: 1, videoId: 1 }, { unique: true });
const YoutubeVideoState = mongoose.model('YoutubeVideoState', YoutubeVideoStateSchema);

// アップロード一覧（新しい順）。1ユニット
const fetchUploadsPlaylist = async (youtubeChannelId) => {
  const response = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
    params: {
      part: 'contentDetails',
      playlistId: youtubeChannelId.replace(/^UC/, 'UU'),
      maxResults: 10,
      key: YOUTUBE_API_KEY
    },
    timeout: 10000
  });
  return (response.data.items || []).map(i => i.contentDetails.videoId);
};

// 動画の詳細（状態・予定時刻つき）。50件まで1ユニット
const fetchVideoDetails = async (videoIds) => {
  const map = new Map();
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'snippet,contentDetails,liveStreamingDetails,status', id: chunk.join(','), key: YOUTUBE_API_KEY },
      timeout: 10000
    });
    for (const item of (response.data.items || [])) {
      if (item.status && item.status.privacyStatus === 'private') continue; // 非公開は無いものとして扱う
      const sn = item.snippet || {};
      const ls = item.liveStreamingDetails || null;
      const state = ['upcoming', 'live'].includes(sn.liveBroadcastContent) ? sn.liveBroadcastContent : 'none';
      const isZeroDuration = /^PT?0[SD]$/.test((item.contentDetails && item.contentDetails.duration) || '');
      let kind = 'video';
      if (ls && state !== 'none') kind = isZeroDuration ? 'stream' : 'premiere';
      const thumbs = sn.thumbnails || {};
      map.set(item.id, {
        videoId: item.id,
        title: sn.title || '（タイトル不明）',
        author: sn.channelTitle || '不明',
        thumbnail: (thumbs.maxres || thumbs.high || thumbs.medium || thumbs.default || {}).url || null,
        publishedAt: sn.publishedAt ? new Date(sn.publishedAt) : null,
        kind, state,
        scheduledStart: ls && ls.scheduledStartTime ? new Date(ls.scheduledStartTime) : null,
        actualStart: ls && ls.actualStartTime ? new Date(ls.actualStartTime) : null,
        url: `https://www.youtube.com/watch?v=${item.id}`
      });
    }
  }
  return map;
};

// 1チャンネル分のチェック。通知すべき動画（新着／配信開始）の配列を返す
const collectYoutubeEvents = async (youtubeChannelId) => {
  const playlistIds = await fetchUploadsPlaylist(youtubeChannelId);
  const records = await YoutubeVideoState.find({ youtubeChannelId });
  const recMap = new Map(records.map(r => [r.videoId, r]));
  const baseline = records.length === 0; // 初回は基準を保存するだけ（過去動画を一括通知しない）

  const trackedIds = records.filter(r => r.state !== 'none').map(r => r.videoId); // 予定・配信中の動画は状態変化を追う
  const unknownIds = playlistIds.filter(id => !recMap.has(id));
  const need = [...new Set([...unknownIds, ...trackedIds])];
  if (need.length === 0) return []; // 変化しうるものが無ければAPI節約

  const details = await fetchVideoDetails(need);
  const events = [];

  // ① 追跡中の動画: 予定 → 配信中 になったら通知。消えた動画は記録も削除
  for (const r of records) {
    if (r.state === 'none') continue;
    const d = details.get(r.videoId);
    if (!d) { await r.deleteOne(); continue; }
    if (d.state !== r.state) {
      if (r.state === 'upcoming' && d.state === 'live' && !baseline) events.push(d);
      r.state = d.state;
      await r.save();
    }
  }

  // ② 未知の動画
  const knownPubs = records.filter(r => playlistIds.includes(r.videoId) && r.publishedAt).map(r => r.publishedAt.getTime());
  const oldestKnownPub = knownPubs.length ? Math.min(...knownPubs) : null;
  let hitKnown = false;
  for (const id of playlistIds) {
    if (recMap.has(id)) { hitKnown = true; continue; }
    const d = details.get(id);
    if (!d) continue; // 削除・非公開
    // 既知の動画より後ろに現れ、かつ既知のどれよりも古い → 最新動画の削除で繰り上がった過去動画
    const promoted = hitKnown && oldestKnownPub !== null && d.publishedAt && d.publishedAt.getTime() < oldestKnownPub;
    await YoutubeVideoState.updateOne(
      { youtubeChannelId, videoId: id },
      { $setOnInsert: { youtubeChannelId, videoId: id, state: d.state, publishedAt: d.publishedAt } },
      { upsert: true }
    );
    if (baseline) continue;
    if (promoted) { console.log(`ℹ️ 【YouTube】繰り上がり扱いで通知をスキップ: ${id}`); continue; }
    events.push(d);
  }

  // 古い記録の掃除（直近100件だけ残す）
  if (records.length + unknownIds.length > 100) {
    const all = await YoutubeVideoState.find({ youtubeChannelId }).sort({ publishedAt: -1 });
    const drop = all.slice(100).map(r => r._id);
    if (drop.length) await YoutubeVideoState.deleteMany({ _id: { $in: drop } });
  }

  const key = v => (v.state === 'live' && v.actualStart ? v.actualStart : (v.scheduledStart || v.publishedAt || new Date(0))).getTime();
  return events.sort((a, b) => key(a) - key(b));
};

// ─── 動画の種類・状態ごとの表示内容 ───
const tsFull = d => `<t:${Math.floor(d.getTime() / 1000)}:F>`;   // 例: 2026年11月25日 20:00
const tsRel  = d => `<t:${Math.floor(d.getTime() / 1000)}:R>`;   // 例: 3時間後（自動で更新される）
// Discord以外のWebhook用: タイムスタンプ記法が使えないので、日本時間の文字列と「あと◯時間◯分」を送信時点で計算して入れる
const fmtJst = d => d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' (JST)';
const fmtRemain = (d) => {
  const min = Math.round((d.getTime() - Date.now()) / 60000);
  if (min <= 0) return 'まもなく';
  const day = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return 'あと約' + (day ? `${day}日` : '') + (h ? `${h}時間` : '') + (!day && m ? `${m}分` : '');
};
const describeYoutube = (v, plain = false) => {
  const full = d => plain ? fmtJst(d) : tsFull(d);
  const rel  = d => plain ? fmtRemain(d) : tsRel(d);
  const when = v.scheduledStart ? `\n⏰ ${full(v.scheduledStart)}（${rel(v.scheduledStart)}）` : '';
  if (v.kind === 'premiere' && v.state === 'upcoming')
    return { color: 0xFFA500, tag: '📅 プレミア公開予定', text: `**${v.author}** がプレミア公開を予定しています！${when}`, button: '▶ 待機所を開く' };
  if (v.kind === 'premiere' && v.state === 'live')
    return { color: 0xFF0000, tag: '🔴 プレミア公開中', text: `🔴 **${v.author}** のプレミア公開が始まりました！`, button: '▶ 視聴する' };
  if (v.kind === 'stream' && v.state === 'upcoming')
    return { color: 0xFFA500, tag: '📅 ライブ配信予定', text: `**${v.author}** がライブ配信を予定しています！${when}`, button: '▶ 配信ページを開く' };
  if (v.kind === 'stream' && v.state === 'live')
    return { color: 0xFF0000, tag: '🔴 ライブ配信中', text: `🔴 **${v.author}** がライブ配信中です！${v.actualStart ? `\n開始: ${plain ? fmtJst(v.actualStart) : tsRel(v.actualStart)}` : ''}`, button: '▶ ライブを見る' };
  return { color: 0xFF0000, tag: '📺 新着動画', text: `**${v.author}** が新しい動画を投稿しました！`, button: '▶ 視聴する' };
};
const youtubeHeadline = (videos) => {
  if (videos.length > 1) return `📺 YouTubeのお知らせです！（${videos.length}件）`;
  return `${describeYoutube(videos[0]).tag}のお知らせです！`;
};

// ─── 登録されている全YouTubeチャンネルの新着をチェック ───
const checkNewYoutubeVideos = async () => {
  console.log("【YouTube】新着動画をチェック中...");
  try {
    const subs = await YoutubeSubscription.find({});

    // Discord通知用（DB登録分）と外部Webhook専用（.env固定分）を合わせて、重複なく監視
    const dbChannelIds = subs.map(s => s.youtubeChannelId);
    const uniqueChannelIds = [...new Set([...dbChannelIds, ...EXTERNAL_YOUTUBE_CHANNEL_IDS])];

    if (uniqueChannelIds.length === 0) {
      console.log('✔ 【YouTube】監視対象のチャンネルはありません。');
      return;
    }

    for (const youtubeChannelId of uniqueChannelIds) {
      try {
        const events = await collectYoutubeEvents(youtubeChannelId);
        if (events.length === 0) continue;

        console.log(`✅ 【YouTube】${events.length} 件を検知 (${youtubeChannelId}): ${events.map(v => `${v.kind}/${v.state}`).join(', ')}`);

        const targetSubs = subs.filter(s => s.youtubeChannelId === youtubeChannelId);
        if (targetSubs.length > 0) await notifyNewYoutubeVideo(targetSubs, events);
        if (EXTERNAL_YOUTUBE_CHANNEL_IDS.includes(youtubeChannelId)) await notifyExternalWebhookYoutube(events);
      } catch (innerError) {
        console.error(`❌ 【YouTube】チャンネル ${youtubeChannelId} のチェック中にエラー:`, innerError && innerError.message ? innerError.message : innerError);
      }
    }
  } catch (error) {
    console.error('❌ 【YouTube】新着チェック処理全体でエラー:', error && error.message ? error.message : error);
  }
};

// ─── Discordチャンネルへの通知（複数でも1メッセージ）───
const notifyNewYoutubeVideo = async (targetSubs, videos) => {
  const list = videos.slice(-10);
  const embeds = list.map(video => {
    const info = describeYoutube(video);
    const embed = new EmbedBuilder()
      .setTitle(clip(video.title, 256))
      .setURL(video.url)
      .setDescription(info.text)
      .setColor(info.color);
    if (video.thumbnail) embed.setImage(video.thumbnail);
    return embed;
  });
  const buttons = list.map(video => new ButtonBuilder()
    .setLabel(list.length === 1 ? describeYoutube(video).button : clip(`▶ ${video.title}`, 80))
    .setStyle(ButtonStyle.Link)
    .setURL(video.url));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  const content = youtubeHeadline(list);

  for (const sub of targetSubs) {
    try {
      const channel = await client.channels.fetch(sub.channelId);
      if (!channel) continue;
      await channel.send({ content, embeds, components: rows });
    } catch (error) {
      console.error(`YouTube通知送信中にエラー (channelId: ${sub.channelId}):`, error && error.message ? error.message : error);
    }
  }
};

// ─── 外部Webhookへの通知 ───
const notifyExternalWebhookYoutube = async (videos) => {
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const blocks = [
    `**${youtubeHeadline(videos)}**`,
    "----------------------------------",
    `検知時刻: ${now}`,
    ""
  ];
  for (const v of videos) {
    const info = describeYoutube(v, true); // Webhookは日本時間のプレーンテキスト
    blocks.push(`**${info.tag}｜${v.title}**\n${info.text}\n▶ ${v.url}\n`);
  }
  await postExternalWebhook(blocks, 'YouTube');
};

// ─── アップデート通知（チェンジログ）───
// 開発者: バージョンが変わるたびに即DM
// サーバー主: 1日に何度更新しても、最短24時間おきに未通知分をまとめて1通だけDM
const CHANGELOG = require('./changelog.js');
const OWNER_DIGEST_COOLDOWN = 24 * 60 * 60 * 1000;

const BotStateSchema = new mongoose.Schema({
  key:                  { type: String, unique: true },
  lastSeenVersion:      { type: String, default: '0.0.0' },  // 開発者に通知済みの最新バージョン
  ownerNotifiedVersion: { type: String, default: '0.0.0' },  // サーバー主に通知済みの最新バージョン
  ownerNotifiedAt:      { type: Date,   default: null }
});
const BotState = mongoose.model('BotState', BotStateSchema);

const cmpVer = (a, b) => {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const buildChangelogEmbed = (entries, footerText) => {
  const sorted = entries.slice().sort((a, b) => cmpVer(b.version, a.version)); // 新しい順
  const text = sorted.map(e =>
    `**v${e.version}**（${e.date}）${e.title}\n` + e.changes.map(c => `・${c}`).join('\n')
  ).join('\n\n');
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🆕 アップデートのお知らせ（v${sorted[0].version}）`)
    .setDescription(clip(text, 4000))
    .setFooter({ text: footerText })
    .setTimestamp();
};

const getDeveloperIds = async () => {
  const ids = (process.env.DEVELOPER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length > 0) return ids;
  try { // 未設定ならBotアプリの所有者（チームの場合はチーム代表）
    const app = await client.application.fetch();
    const o = app.owner;
    return o ? [o.ownerId || o.id] : [];
  } catch (e) {
    console.warn('開発者IDの取得に失敗:', e.message);
    return [];
  }
};

const sendDM = async (userId, payload) => {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch (e) {
    console.warn(`DM送信失敗 (${userId}):`, e.message);
    return false;
  }
};

const notifyDevelopers = async (entries) => {
  const ids = await getDeveloperIds();
  const embed = buildChangelogEmbed(entries, '開発者向け通知（バージョン更新時に毎回送信）');
  const content = `🛠️ ボットを **v${entries.reduce((a, b) => cmpVer(a.version, b.version) >= 0 ? a : b).version}** に更新しました（${client.guilds.cache.size} サーバーで稼働中）`;
  for (const id of ids) await sendDM(id, { content, embeds: [embed] });
};

const notifyGuildOwners = async (entries, excludeIds = []) => {
  const owners = new Set(client.guilds.cache.map(g => g.ownerId));
  excludeIds.forEach(id => owners.delete(id));
  const embed = buildChangelogEmbed(entries, 'このお知らせはサーバーのオーナーにお送りしています（更新が続いた場合は1日1回にまとめて送信）');
  let ok = 0;
  for (const id of owners) {
    if (await sendDM(id, { content: '📢 Beans Bot がアップデートされました！', embeds: [embed] })) ok++;
    await sleep(1000); // レート制限対策
  }
  console.log(`📢 サーバー主へ更新通知: ${ok}/${owners.size} 件送信`);
};

let changelogBusy = false;
const checkChangelog = async () => {
  if (changelogBusy || CHANGELOG.length === 0) return;
  changelogBusy = true;
  try {
    let state = await BotState.findOne({ key: 'main' });
    if (!state) state = await BotState.create({ key: 'main' });
    const latest = CHANGELOG.reduce((a, b) => cmpVer(a.version, b.version) >= 0 ? a : b);

    // ① 開発者: バージョンが上がっていたら即通知（先に状態を保存して二重送信を防ぐ）
    const devPending = CHANGELOG.filter(e => cmpVer(e.version, state.lastSeenVersion) > 0);
    if (devPending.length > 0) {
      state.lastSeenVersion = latest.version;
      await state.save();
      console.log(`🆕 バージョン更新を検知: v${latest.version}`);
      await notifyDevelopers(devPending);
    }

    // ② サーバー主: 未通知分があり、前回から24時間以上空いている（またはimportant）ときだけ、まとめて1通
    const ownerPending = CHANGELOG.filter(e => cmpVer(e.version, state.ownerNotifiedVersion) > 0);
    if (ownerPending.length > 0) {
      const elapsed = state.ownerNotifiedAt ? Date.now() - state.ownerNotifiedAt.getTime() : Infinity;
      if (elapsed >= OWNER_DIGEST_COOLDOWN || ownerPending.some(e => e.important)) {
        state.ownerNotifiedVersion = latest.version;
        state.ownerNotifiedAt = new Date();
        await state.save();
        await notifyGuildOwners(ownerPending, await getDeveloperIds());
      } else {
        const wait = Math.ceil((OWNER_DIGEST_COOLDOWN - elapsed) / 3600000);
        console.log(`⏳ サーバー主への更新通知は約${wait}時間後にまとめて送信します（未通知 ${ownerPending.length} 件）`);
      }
    }
  } catch (e) {
    console.error('❌ チェンジログ通知でエラー:', e && e.message ? e.message : e);
  } finally {
    changelogBusy = false;
  }
};

// ─── イベントハンドラ ───
client.once('ready', async () => {
  const serverCount = client.guilds.cache.size;
  console.log(`✅ Botが ${client.user.tag} としてログインしました!`);
  client.user.setActivity({
    name: `${serverCount} サーバーを監視中...`,
    type: 3,
  });
  await checkAll();
  setInterval(checkAll, CHECK_INTERVAL);
});

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const cmd = client.commands.get(interaction.commandName);
    if (cmd && cmd.autocomplete) await cmd.autocomplete(interaction).catch(e => console.error('autocompleteエラー:', e));
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const errorMessage = 'エラーが発生しました！';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errorMessage, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
    }
  }
});

// ─── サーバーとシャットダウン ───
const app = express();
app.get('/', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
const server = app.listen(process.env.PORT || 3000);

const shutdown = async () => {
  console.log('シャットダウン開始...');
  try {
    if (server && server.close) server.close();
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
    if (client) client.destroy();
  } catch (e) {
    console.warn('接続切断でエラー:', e);
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    await client.login(TOKEN);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();