require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const Database = require('better-sqlite3');

// ─── Client 初期化 ───
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '!';

// ─── MongoDB接続とデータモデル定義 ───
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDBに接続しました'))
  .catch(err => console.error('❌ MongoDB接続エラー:', err));

// last_levels のデータモデル
const levelSchema = new mongoose.Schema({
  levelId: { type: String, required: true, unique: true }
});
const LastLevel = mongoose.model('LastLevel', levelSchema);

// サーバー設定のデータモデル
const subscriptionSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  channelId: { type: String, required: true },
  roleId: { type: String, default: null }
});
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// コマンドの読み込み
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  client.commands.set(command.data.name, command);
}

const API_URL = "https://s.lolbeans.io/level-list?i=0&t=1&n=10&m";
const CHECK_INTERVAL = 10 * 60 * 1000; // 10分

// ─── データ移行 ───
const migrateFromOldSources = async () => {
  try {
    // SQLiteからのデータ移行
    if (fs.existsSync('settings.db')) {
      const db = new Database('settings.db', { readonly: true });
      const rows = db.prepare('SELECT * FROM subscriptions').all();
      if (rows.length > 0) {
        console.log(`SQLiteから${rows.length}件のデータを移行します...`);
        const docs = rows.map(r => ({
          guildId: r.guild_id,
          channelId: r.channel_id,
          roleId: r.role_id
        }));
        await Subscription.insertMany(docs, { ordered: false });
        console.log('✅ SQLiteからのデータ移行が完了しました。');
      }
      db.close();
    }
  } catch (e) {
    console.error('❌ SQLiteからのデータ移行中にエラーが発生しました:', e);
  } finally {
    // 移行の成否に関わらず、ファイルが存在すれば削除を試みる
    if (fs.existsSync('settings.db')) {
      fs.unlinkSync('settings.db');
      console.log('✔ settings.dbを削除しました。');
    }
  }

  try {
    // JSONファイルからのデータ移行
    if (fs.existsSync('last_levels.json')) {
      const data = fs.readFileSync('last_levels.json', 'utf-8');
      const levelIds = JSON.parse(data);
      if (levelIds.length > 0) {
        console.log(`JSONファイルから${levelIds.length}件のデータを移行します...`);
        const docs = levelIds.map(id => ({ levelId: id.toString() }));
        await LastLevel.insertMany(docs, { ordered: false });
        console.log('✅ JSONファイルからのデータ移行が完了しました。');
      }
    }
  } catch (e) {
    console.error('❌ JSONファイルからのデータ移行中にエラーが発生しました:', e);
  } finally {
    // 移行の成否に関わらず、ファイルが存在すれば削除を試みる
    if (fs.existsSync('last_levels.json')) {
      fs.unlinkSync('last_levels.json');
      console.log('✔ last_levels.jsonを削除しました。');
    }
  }
};

// ─── ファイル読み書き関数の変更 ───
const loadLastLevels = async () => {
  try {
    const levels = await LastLevel.find({}, 'levelId');
    return new Set(levels.map(level => level.levelId));
  } catch (error) {
    console.error("MongoDBからのレベルID読み込みに失敗:", error);
    return new Set();
  }
};

const saveLastLevels = async (levelIds) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await LastLevel.deleteMany({}, { session });
    const newDocs = Array.from(levelIds).map(id => ({ levelId: id }));
    await LastLevel.insertMany(newDocs, { session });
    await session.commitTransaction();
    console.log("✔ レベルIDをMongoDBに保存しました");
  } catch (error) {
    await session.abortTransaction();
    console.error("MongoDBへのレベルID保存に失敗:", error);
  } finally {
    session.endSession();
  }
};

// ─── 既存のヘルパー関数（変更なし） ───
async function fetchLolBeansLobbyAsync(levelIdOrCode) {
  if (!levelIdOrCode) return null;
  const candidates = [
    `https://s.lolbeans.io/level/${encodeURIComponent(levelIdOrCode)}`,
    `https://s.lolbeans.io/levels/${encodeURIComponent(levelIdOrCode)}`,
    `https://s.lolbeans.io/api/level/${encodeURIComponent(levelIdOrCode)}`,
    `https://s.lolbeans.io/api/levels/${encodeURIComponent(levelIdOrCode)}`
  ];
  for (const url of candidates) {
    try {
      const res = await axios.get(url, { timeout: 5000 });
      if (res.status === 200 && res.data) {
        return res.data;
      }
    } catch (err) {
      // 次の候補へ
    }
  }
  return null;
}

async function fetchLolBeansLeaderboardAsync(levelId) {
  if (!levelId) return null;
  const candidates = [
    `https://s.lolbeans.io/levels/${encodeURIComponent(levelId)}/leaderboard`,
    `https://s.lolbeans.io/level/${encodeURIComponent(levelId)}/leaderboard`,
    `https://s.lolbeans.io/api/levels/${encodeURIComponent(levelId)}/leaderboard`,
    `https://s.lolbeans.io/api/level/${encodeURIComponent(levelId)}/leaderboard`
  ];
  for (const url of candidates) {
    try {
      const res = await axios.get(url, { timeout: 5000 });
      if (res.status === 200 && res.data) {
        return res.data;
      }
    } catch (err) {
      // 次の候補へ
    }
  }
  return null;
}

// ─── 新規コースチェック＆通知ロジック ───
const checkNewLevels = async () => {
  console.log("新しいレベルをチェック中...");
  try {
    const response = await axios.get(API_URL, { timeout: 10000 });
    if (response.status !== 200 || !response.data || !response.data.l) {
      console.log("API レスポンスが想定と異なります。");
      return;
    }
    
    const levels = response.data.l;
    const currentLevelIds = new Set(levels.map(level => level.levelId.toString()));
    const lastLevelIds = await loadLastLevels();
    
    const newLevelIds = [...currentLevelIds].filter(id => !lastLevelIds.has(id));
    if (newLevelIds.length > 0) {
      console.log(`${newLevelIds.length}件の新しいレベルが見つかりました！`);
      const newLevels = levels.filter(level => newLevelIds.includes(level.levelId.toString()));
      await notifyNewLevels(newLevels);
      await saveLastLevels(currentLevelIds);
    } else {
      console.log("新しいレベルはありませんでした。");
    }
  } catch (error) {
    console.error("レベルチェック中にエラーが発生しました:", error && error.message ? error.message : error);
  }
};

const notifyNewLevels = async (newLevels) => {
  const allSubs = await Subscription.find({});
  for (const settings of allSubs) {
    try {
      const channel = await client.channels.fetch(settings.channelId);
      if (!channel) continue;

      const roleMention = settings.roleId ? `<@&${settings.roleId}>` : "";
      const sorted = newLevels.slice().sort((a, b) => {
        const ai = Number(a.levelId) || 0;
        const bi = Number(b.levelId) || 0;
        return ai - bi;
      });
      for (const level of sorted) {
        const embed = new EmbedBuilder()
          .setTitle("新しいコースが追加されました！ 🌟")
          .setDescription(`**${level.name || '名前なし'}**`)
          .setColor(0x00FF00)
          .setThumbnail(`https://lolbeans.io/ui/level-thumbnails/${level.levelId}.png`)
          .addFields(
            { name: "✏️ 作者", value: `\`${level.author || '不明'}\``, inline: false },
            { name: "📄 説明", value: level.description || 'なし', inline: false }
          );
        await channel.send({ content: `${roleMention} 新規コースのお知らせです！`, embeds: [embed] });
      }
    } catch (error) {
      console.error(`サーバーID ${settings.guildId} への通知送信中にエラー:`, error && error.message ? error.message : error);
    }
  }
};

// ─── Ready ───
let lastLevels = new Set();
client.once('clientReady', async () => {
  console.log(`✅ Ready! Logged in as ${client.user.tag}`);

  console.log("参加しているサーバー:");
  client.guilds.cache.forEach(guild => {
    console.log(`- ${guild.name} (ID: ${guild.id})`);
  });

  await migrateFromOldSources();
  lastLevels = await loadLastLevels();
  
  checkNewLevels();
  setInterval(checkNewLevels, CHECK_INTERVAL);
});

// ─── Message コマンド ───
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  if (cmd === 'ping') {
    const sent = await message.channel.send('Pinging...');
    const rtt = sent.createdTimestamp - message.createdTimestamp;
    await sent.edit(`Pong! RTT: ${rtt} ms`);
  }

  if (cmd === 'leader') {
    const levelId = args[0];
    if (!levelId) {
      return message.channel.send('使い方: !leader <levelId>');
    }
    
    const loadingMsg = await message.channel.send('リーダーボードを取得しています...');
    try {
      const data = await fetchLolBeansLeaderboardAsync(levelId);
      if (!data) {
        return loadingMsg.edit('リーダーボードを取得できませんでした。');
      }

      let desc = '';
      if (Array.isArray(data.entries)) {
        desc = data.entries.slice(0, 10).map((e, i) => `${i+1}. ${e.name || e.player || 'Unknown'} - ${e.time || e.score || ''}`).join('\n');
      } else if (Array.isArray(data.list)) {
        desc = data.list.slice(0, 10).map((e, i) => `${i+1}. ${e.name || e.player || 'Unknown'} - ${e.time || e.score || ''}`).join('\n');
      } else {
        desc = '取得したデータ: ```json\n' + JSON.stringify(data).slice(0, 1000) + '\n```';
      }

      const embed = new EmbedBuilder()
        .setTitle(`Leaderboard: ${levelId}`)
        .setDescription(desc)
        .setColor(0x0099FF);
      await loadingMsg.edit({ content: null, embeds: [embed] });
    } catch (err) {
      console.error('!leader 実行中にエラー:', err);
      await loadingMsg.edit('リーダーボード取得中にエラーが発生しました。');
    }
  }
});

// ─── Slash コマンドハンドラ ───
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);

  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(err);
    const message = { content: 'コマンド実行中にエラーが発生しました。', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
        await interaction.followUp(message);
    } else {
        await interaction.reply(message);
    }
  }
});

// ─── HTTP ヘルスサーバ（Koyeb のヘルスチェック対策） ───
const app = express();
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});

// ─── ログイン（トークン無ければ落ちない） ───
(async () => {
  if (!TOKEN) {
    console.warn('DISCORD_TOKEN が設定されていません。Bot はログインしません（テストモード）。');
  } else {
    try {
      await client.login(TOKEN);
    } catch (err) {
      console.error('Discord へのログインに失敗しました:', err);
    }
  }
})();

// Graceful shutdown
const shutdown = async () => {
  console.log('シャットダウン開始...');
  try {
    if (server && server.close) {
      server.close(() => console.log('HTTP サーバを停止しました。'));
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
      console.log('MongoDB接続を切断しました。');
    }
    if (client && client.destroy) {
      await client.destroy();
      console.log('Discord クライアントを破棄しました。');
    }
  } catch (err) {
    console.error('シャットダウン中にエラー:', err);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});