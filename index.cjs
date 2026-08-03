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
  youtubeChannelId: { type: String, required: true }   // 監視対象のYouTubeチャンネルID (UC...)
});
// YouTube: 各YouTubeチャンネルごとに最後に検知した動画IDを保存
const LastYoutubeVideoSchema = new mongoose.Schema({
  youtubeChannelId: { type: String, unique: true },
  videoId:          { type: String }
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

    const currentLevelIds = new Set(currentLevels.map(l => l.levelId.toString()));
    const lastLevels      = await LastLevel.find({});
    const lastLevelIdSet  = new Set(lastLevels.map(l => l.levelId));

    const newLevels = currentLevels.filter(level => !lastLevelIdSet.has(level.levelId.toString()));

    if (newLevels.length > 0) {
      console.log(`✅ 【通常】${newLevels.length} 個のコースを検知！`);
      await notifyNewLevels(newLevels, false);
      await notifyExternalWebhook(newLevels, false);

      await LastLevel.deleteMany({});
      const docs = Array.from(currentLevelIds).map(id => ({ levelId: id }));
      await LastLevel.insertMany(docs, { ordered: false });
    } else {
      console.log('✔ 【通常】新規コースは検知されませんでした。');
    }
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

    const currentLevelIds  = new Set(currentLevels.map(l => l.levelId.toString()));
    const lastLevels       = await LastHardcoreLevel.find({});
    const lastLevelIdSet   = new Set(lastLevels.map(l => l.levelId));

    const newLevels = currentLevels.filter(level => !lastLevelIdSet.has(level.levelId.toString()));

    if (newLevels.length > 0) {
      console.log(`✅ 【Hardcore】${newLevels.length} 個のコースを検知！`);
      await notifyNewLevels(newLevels, true);
      await notifyExternalWebhook(newLevels, true);

      await LastHardcoreLevel.deleteMany({});
      const docs = Array.from(currentLevelIds).map(id => ({ levelId: id }));
      await LastHardcoreLevel.insertMany(docs, { ordered: false });
    } else {
      console.log('✔ 【Hardcore】新規コースは検知されませんでした。');
    }
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

  const serverCount = client.guilds.cache.size;
  client.user.setActivity({
    name: `${serverCount} サーバーを監視中...`,
    type: 3,
  });
};

// ─── Discord通知（isHardcore フラグで見た目を切り替え）───
const notifyNewLevels = async (newLevels, isHardcore) => {
  const allSubs = await Subscription.find({});
  for (const settings of allSubs) {
    try {
      const channel = await client.channels.fetch(settings.channelId);
      if (!channel) continue;

      const roleMention = settings.roleId ? `<@&${settings.roleId}>` : "";
      const sorted = newLevels.slice().sort((a, b) => (Number(a.levelId) || 0) - (Number(b.levelId) || 0));

      for (const level of sorted) {
        const courseType = LEVEL_TYPES[level.type] || '❓ 不明 (Unknown)';

        const descLines = [
          `**${level.name || '名前なし'}**`,
          `${courseType} ｜ \`${level.author || '不明'}\``,
        ];
        if (level.description) descLines.push(level.description);

        const embed = new EmbedBuilder()
          .setTitle(isHardcore
            ? "🔥 Hardcoreコースが追加されました！"
            : "新しいコースが追加されました！ 🌟")
          .setDescription(descLines.join('\n'))
          .setColor(isHardcore ? 0xFF4500 : 0x00FF00)
          .setThumbnail(`https://lolbeans.io/ui/level-thumbnails/${level.levelId}.png`);

        if (isHardcore) {
          embed.setFooter({ text: "💀 Hardcore" });
        }

        const contentText = isHardcore
          ? `${roleMention} 🔥 Hardcoreの新規コースのお知らせです！`
          : `${roleMention} 新規コースのお知らせです！`;

        const playButton = new ButtonBuilder()
          .setLabel('▶ プレイ')
          .setStyle(ButtonStyle.Link)
          .setURL(levelIdToPlayUrl(level.levelId));
        const row = new ActionRowBuilder().addComponents(playButton);

        await channel.send({ content: contentText, embeds: [embed], components: [row] });
      }
    } catch (error) {
      console.error(`サーバーID ${settings.guildId} への通知送信中にエラー:`, error && error.message ? error.message : error);
    }
  }
};

// ─── 外部Webhook通知 ───
const notifyExternalWebhook = async (newLevels, isHardcore) => {
  // .env の EXTERNAL_WEBHOOK_URL はカンマ区切りで複数指定可能
  // 例: EXTERNAL_WEBHOOK_URL=https://discord.com/api/webhooks/xxx,https://discord.com/api/webhooks/yyy
  const WEBHOOK_URLS = (process.env.EXTERNAL_WEBHOOK_URL || '')
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0);

  if (WEBHOOK_URLS.length === 0) {
    console.warn("⚠️ EXTERNAL_WEBHOOK_URL が .env に設定されていないため、外部送信をスキップします。");
    return;
  }

  const sorted = newLevels.slice().sort((a, b) => (Number(a.levelId) || 0) - (Number(b.levelId) || 0));

  for (const level of sorted) {
    try {
      const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const courseTypeText = LEVEL_TYPES_TEXT[level.type] || '不明 (Unknown)';
      const playUrl = levelIdToPlayUrl(level.levelId);

      const header = isHardcore
        ? "**🔥 新規Hardcoreコミュニティレベルが追加されました！**"
        : "**新規コミュニティレベルが追加されました！**";

      const lines = [
        header,
        "----------------------------------",
        `**${level.name || '名前なし'}**`,
        `${courseTypeText} | ${level.author || '不明'}`,
      ];
      if (level.description) lines.push(level.description);
      lines.push(`検知時刻: ${now}`, "", `▶ こちらのリンクからプレイできます: ${playUrl}`);

      const payload = {
        username: "ろるー@ディスコボット",
        content: lines.join('\n')
      };

      for (const url of WEBHOOK_URLS) {
        try {
          await axios.post(url, payload);
          console.log(`✅ 外部Webhook送信成功 (${url}): ${level.levelId}${isHardcore ? ' [Hardcore]' : ''}`);
        } catch (error) {
          console.error(`❌ 外部Webhook送信失敗 (${url}):`, error.message);
        }
      }
    } catch (error) {
      console.error(`❌ 外部Webhook通知処理中にエラー:`, error.message);
    }
  }
};

// ─── YouTube Data API v3から最新動画を取得 ───
// UC...のチャンネルIDをUU...のアップロード動画プレイリストIDに変換して取得
const fetchLatestYoutubeVideo = async (youtubeChannelId) => {
  const uploadsPlaylistId = youtubeChannelId.replace(/^UC/, 'UU');

  const response = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
    params: {
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: 1,
      key: YOUTUBE_API_KEY
    },
    timeout: 10000
  });

  const items = response.data.items;
  if (!items || items.length === 0) return null;

  const item = items[0];
  const videoId = item.contentDetails.videoId;
  const snippet = item.snippet;

  return {
    videoId,
    title: snippet.title || '（タイトル不明）',
    author: snippet.channelTitle || '不明',
    thumbnail: (snippet.thumbnails && (snippet.thumbnails.high || snippet.thumbnails.default))
      ? (snippet.thumbnails.high ? snippet.thumbnails.high.url : snippet.thumbnails.default.url)
      : null,
    publishedAt: snippet.publishedAt || null,
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
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
        const latest = await fetchLatestYoutubeVideo(youtubeChannelId);
        if (!latest) continue;

        const lastDoc = await LastYoutubeVideo.findOne({ youtubeChannelId });

        if (!lastDoc) {
          // 初回登録時は基準を保存するだけ（過去動画を一括通知しない）
          await LastYoutubeVideo.create({ youtubeChannelId, videoId: latest.videoId });
          continue;
        }

        if (lastDoc.videoId !== latest.videoId) {
          console.log(`✅ 【YouTube】新着動画を検知: ${latest.title} (${youtubeChannelId})`);

          // Discord通知: このチャンネルIDがDBに登録されている場合のみ
          const targetSubs = subs.filter(s => s.youtubeChannelId === youtubeChannelId);
          if (targetSubs.length > 0) {
            await notifyNewYoutubeVideo(targetSubs, latest);
          }

          // 外部Webhook通知: .envのリストに含まれている場合のみ
          if (EXTERNAL_YOUTUBE_CHANNEL_IDS.includes(youtubeChannelId)) {
            await notifyExternalWebhookYoutube(latest);
          }

          lastDoc.videoId = latest.videoId;
          await lastDoc.save();
        }
      } catch (innerError) {
        console.error(`❌ 【YouTube】チャンネル ${youtubeChannelId} のチェック中にエラー:`, innerError && innerError.message ? innerError.message : innerError);
      }
    }
  } catch (error) {
    console.error('❌ 【YouTube】新着チェック処理全体でエラー:', error && error.message ? error.message : error);
  }
};

// ─── Discordチャンネルへの新着動画通知 ───
const notifyNewYoutubeVideo = async (targetSubs, video) => {
  for (const sub of targetSubs) {
    try {
      const channel = await client.channels.fetch(sub.channelId);
      if (!channel) continue;

      const embed = new EmbedBuilder()
        .setTitle(video.title)
        .setURL(video.url)
        .setDescription(`**${video.author}** が新しい動画を投稿しました！`)
        .setColor(0xFF0000);

      if (video.thumbnail) embed.setImage(video.thumbnail);

      const watchButton = new ButtonBuilder()
        .setLabel('▶ 視聴する')
        .setStyle(ButtonStyle.Link)
        .setURL(video.url);
      const row = new ActionRowBuilder().addComponents(watchButton);

      await channel.send({ content: `📺 新着動画のお知らせです！`, embeds: [embed], components: [row] });
    } catch (error) {
      console.error(`YouTube通知送信中にエラー (channelId: ${sub.channelId}):`, error && error.message ? error.message : error);
    }
  }
};

// ─── 外部Webhookへの新着動画通知（Discordチャンネル登録の有無とは無関係に送信） ───
const notifyExternalWebhookYoutube = async (video) => {
  const WEBHOOK_URLS = (process.env.EXTERNAL_WEBHOOK_URL || '')
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0);

  if (WEBHOOK_URLS.length === 0) {
    console.warn("⚠️ EXTERNAL_WEBHOOK_URL が .env に設定されていないため、YouTube通知の外部送信をスキップします。");
    return;
  }

  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const lines = [
    "**📺 新着YouTube動画のお知らせ**",
    "----------------------------------",
    `**${video.title}**`,
    `投稿者: ${video.author}`,
    `検知時刻: ${now}`,
    "",
    `▶ こちらから視聴できます: ${video.url}`
  ];

  const payload = {
    username: "ろるー@ディスコボット",
    content: lines.join('\n')
  };

  for (const url of WEBHOOK_URLS) {
    try {
      await axios.post(url, payload);
      console.log(`✅ 外部Webhook送信成功 (YouTube, ${url}): ${video.videoId}`);
    } catch (error) {
      console.error(`❌ 外部Webhook送信失敗 (YouTube, ${url}):`, error.message);
    }
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
  if (!interaction.isCommand()) return;
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