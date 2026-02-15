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

const API_URL = "https://s.lolbeans.io/level-list?i=0&t=1&n=10&m";
const CHECK_INTERVAL = 10 * 60 * 1000; // 10分 (10 minutes)

// ─── MongoDB スキーマ定義 / MongoDB Schema Definitions ───
const SubscriptionSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  roleId: { type: String, default: null }
});
const LastLevelSchema = new mongoose.Schema({
  levelId: { type: String, unique: true }
});
const Subscription = mongoose.model('Subscription', SubscriptionSchema);
const LastLevel = mongoose.model('LastLevel', LastLevelSchema);

// ─── Client 初期化 / Client Initialization ───
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
client.commands = new Collection();
const TOKEN = process.env.DISCORD_TOKEN;

// ─── コマンド読み込み / Command Loading ───
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

// ─── 新しいレベル検知・通知ロジック ───
const CUSTOM_EMOJIS = {
  0: { name: 'sandbox',    id: '1437504794557153430' },
  1: { name: 'timed',      id: '1437504792451747901' },
  2: { name: 'competitive',id: '1437504797547696188' },
  3: { name: 'elimination',id: '1437504795899330560' }
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

const checkNewLevels = async () => {
  client.user.setActivity({ name: "レベルを検知中... 📡", type: 3 }); 
  
  console.log("新しいレベルをチェック中...");
  try {
    const response = await axios.get(API_URL, { timeout: 10000 });
    const currentLevels = response.data.l;

    if (!Array.isArray(currentLevels)) {
      console.error('APIから予期しないデータを受信:', JSON.stringify(response.data, null, 2));
      return;
    }

    const currentLevelIds = new Set(currentLevels.map(l => l.levelId.toString()));
    const lastLevels = await LastLevel.find({});
    const lastLevelIdSet = new Set(lastLevels.map(l => l.levelId));

    const newLevels = currentLevels.filter(level => !lastLevelIdSet.has(level.levelId.toString()));
    
    if (newLevels.length > 0) {
      console.log(`✅ ${newLevels.length} 個のコミュを検知！`); 
      
      // Discord通知
      await notifyNewLevels(newLevels);
      
      // 外部Webhook通知（.envを使用）
      await notifyExternalWebhook(newLevels);

      await LastLevel.deleteMany({});
      const docs = Array.from(currentLevelIds).map(id => ({ levelId: id }));
      await LastLevel.insertMany(docs, { ordered: false });
    } else {
      console.log('✔ コミュニティレベルは検知されませんでした。');
    }
  } catch (error) {
    console.error('❌ 新規レベルチェック中にエラーが発生しました:', error && error.message ? error.message : error);
  } finally {
    const serverCount = client.guilds.cache.size;
    client.user.setActivity({
      name: `${serverCount} サーバーを監視中...`,
      type: 3,
    });
  }
};

const notifyNewLevels = async (newLevels) => {
  const allSubs = await Subscription.find({});
  for (const settings of allSubs) {
    try {
      const channel = await client.channels.fetch(settings.channelId);
      if (!channel) continue;

      const roleMention = settings.roleId ? `<@&${settings.roleId}>` : "";
      const sorted = newLevels.slice().sort((a, b) => (Number(a.levelId) || 0) - (Number(b.levelId) || 0));
      
      for (const level of sorted) {
        const courseType = LEVEL_TYPES[level.type] || '❓ 不明 (Unknown)';
        const embed = new EmbedBuilder()
          .setTitle("新しいコースが追加されました！ 🌟")
          .setDescription(`**${level.name || '名前なし'}**`)
          .setColor(0x00FF00)
          .setThumbnail(`https://lolbeans.io/ui/level-thumbnails/${level.levelId}.png`)
          .addFields(
            { name: "🏷️ コース種類", value: `**${courseType}**`, inline: true },
            { name: "✏️ 作者", value: `\`${level.author || '不明'}\``, inline: true },
            { name: "📄 説明", value: level.description || 'なし', inline: false }
          );
        await channel.send({ content: `${roleMention} 新規コースのお知らせです！`, embeds: [embed] });
      }
    } catch (error) {
      console.error(`サーバーID ${settings.guildId} への通知送信中にエラー:`, error && error.message ? error.message : error);
    }
  }
};

// ─── 外部Webhookへの通知関数 (環境変数を使用) ───
const notifyExternalWebhook = async (newLevels) => {
  // 環境変数からURLを取得
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

      const payload = {
        username: "ろるー@ディスコボット",
        content: "**新規コミュニティレベルが追加されました！**\n" +
                 "----------------------------------\n" +
                 `📛 **コース名**: ${level.name || '名前なし'}\n` +
                 `🏷️ **種類**: ${courseTypeText}\n` +
                 `👤 **作者**: ${level.author || '不明'}\n` +
                 `検知時刻: ${now}\n` +
                 "\n" +
                 `${imageUrl}`
      };

      await axios.post(WEBHOOK_URL, payload);
      console.log(`✅ 外部Webhook送信成功: ${level.levelId}`);
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
  await checkNewLevels();
  setInterval(checkNewLevels, CHECK_INTERVAL);
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