require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
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

const Subscription       = mongoose.model('Subscription',      SubscriptionSchema);
const LastLevel          = mongoose.model('LastLevel',          LastLevelSchema);
const LastHardcoreLevel  = mongoose.model('LastHardcoreLevel',  LastHardcoreLevelSchema);

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

        await channel.send({ content: contentText, embeds: [embed] });
      }
    } catch (error) {
      console.error(`サーバーID ${settings.guildId} への通知送信中にエラー:`, error && error.message ? error.message : error);
    }
  }
};

// ─── 外部Webhook通知 ───
const notifyExternalWebhook = async (newLevels, isHardcore) => {
  const WEBHOOK_URL = process.env.EXTERNAL_WEBHOOK_URL;

  if (!WEBHOOK_URL) {
    console.warn("⚠️ EXTERNAL_WEBHOOK_URL が .env に設定されていないため、外部送信をスキップします。");
    return;
  }

  const sorted = newLevels.slice().sort((a, b) => (Number(a.levelId) || 0) - (Number(b.levelId) || 0));

  for (const level of sorted) {
    try {
      const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const courseTypeText = LEVEL_TYPES_TEXT[level.type] || '不明 (Unknown)';
      const imageUrl = `https://lolbeans.io/ui/level-thumbnails/${level.levelId}.png`;

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
      lines.push(`検知時刻: ${now}`, "", imageUrl);

      const payload = {
        username: "ろるー@ディスコボット",
        content: lines.join('\n')
      };

      await axios.post(WEBHOOK_URL, payload);
      console.log(`✅ 外部Webhook送信成功: ${level.levelId}${isHardcore ? ' [Hardcore]' : ''}`);
    } catch (error) {
      console.error(`❌ 外部Webhook送信失敗:`, error.message);
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