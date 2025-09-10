require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');

const API_URL = "https://s.lolbeans.io/level-list?i=0&t=1&n=10&m";
const CHECK_INTERVAL = 10 * 60 * 1000; // 10分

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
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.log(`[警告] ${filePath} に必要な "data" または "execute" プロパティがありません。 / [WARNING] The file at ${filePath} is missing the required "data" or "execute" properties.`);
  }
}

// ─── データ移行 / Data Migration ───
const migrateFromOldSources = async () => {
  try {
    // SQLiteからのデータ移行 / Data migration from SQLite
    if (fs.existsSync('settings.db')) {
      console.log('SQLiteからMongoDBへデータを移行中... / Migrating data from SQLite to MongoDB...');
      const Database = require('better-sqlite3');
      const db = new Database('settings.db', { readonly: true });
      const rows = db.prepare('SELECT * FROM subscriptions').all();
      if (rows.length > 0) {
        const docs = rows.map(r => ({
          guildId: r.guild_id,
          channelId: r.channel_id,
          roleId: r.role_id
        }));
        await Subscription.insertMany(docs, { ordered: false });
        console.log('✅ SQLiteからのデータ移行が完了しました。 / ✅ Data migration from SQLite is complete.');
      }
      db.close();
    }
  } catch (e) {
    console.error('❌ SQLiteからのデータ移行中にエラーが発生しました:', e); // ❌ An error occurred during data migration from SQLite:
  } finally {
    if (fs.existsSync('settings.db')) {
      fs.unlinkSync('settings.db');
      console.log('✔ settings.dbを削除しました。 / ✔ settings.db has been deleted.');
    }
  }

  try {
    // JSONファイルからのデータ移行 / Data migration from JSON file
    if (fs.existsSync('last_levels.json')) {
      console.log('JSONファイルからMongoDBへデータを移行中... / Migrating data from JSON file to MongoDB...');
      const data = fs.readFileSync('last_levels.json', 'utf-8');
      const levelIds = JSON.parse(data);
      if (levelIds.length > 0) {
        const docs = levelIds.map(id => ({ levelId: id.toString() }));
        await LastLevel.insertMany(docs, { ordered: false });
        console.log('✅ JSONファイルからのデータ移行が完了しました。 / ✅ Data migration from JSON file is complete.');
      }
    }
  } catch (e) {
    console.error('❌ JSONファイルからのデータ移行中にエラーが発生しました:', e); // ❌ An error occurred during data migration from JSON file:
  } finally {
    if (fs.existsSync('last_levels.json')) {
      fs.unlinkSync('last_levels.json');
      console.log('✔ last_levels.jsonを削除しました。 / ✔ last_levels.json has been deleted.');
    }
  }
};

// ─── 新しいレベル検知・通知ロジック / New Level Detection and Notification Logic ───
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
    const lastLevelIds = await LastLevel.find({}, 'levelId');
    const lastLevelIdSet = new Set(lastLevelIds.map(level => level.levelId));

    const newLevelIds = [...currentLevelIds].filter(id => !lastLevelIdSet.has(id));
    if (newLevelIds.length > 0) {
      console.log(`${newLevelIds.length}件の新しいレベルが見つかりました！`);
      const newLevels = levels.filter(level => newLevelIds.includes(level.levelId.toString()));
      await notifyNewLevels(newLevels);
      
      await LastLevel.deleteMany({});
      const newDocs = Array.from(currentLevelIds).map(id => ({ levelId: id }));
      await LastLevel.insertMany(newDocs, { ordered: false });
      console.log("✔ 新しいレベルIDをMongoDBに保存しました。");
    } else {
      console.log("新しいレベルはありませんでした。");
    }
  } catch (error) {
    console.error("レベルチェック中にエラーが発生しました:", error);
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

// ─── イベントハンドラ / Event Handlers ───
client.once('clientReady', async () => {
  console.log(`✅ Ready! Logged in as ${client.user.tag}`);

  const serverCount = client.guilds.cache.size;
  client.user.setActivity(`${serverCount}個のサーバーで稼働中 / Operating on ${serverCount} servers`, { type: 0 });

  await migrateFromOldSources();

  // 新しいレベルのチェックを起動時に実行し、その後定期的に繰り返す
  checkNewLevels();
  setInterval(checkNewLevels, CHECK_INTERVAL);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`コマンド "${interaction.commandName}" の実行中にエラーが発生しました:`, error);

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'コマンド実行中にエラーが発生しました。 / An error occurred during command execution.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'コマンド実行中にエラーが発生しました。 / An error occurred during command execution.', ephemeral: true });
      }
    } catch (replyError) {
      console.error('インタラクションへのエラー返信中に、さらにエラーが発生しました:', replyError);
    }
  }
});

// ─── 起動・シャットダウン処理 / Startup and Shutdown Processing ───
const app = express();
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});
const shutdown = async () => {
  console.log('シャットダウン開始... / Starting shutdown...');
  try {
    if (server && server.close) {
      server.close(() => console.log('HTTP サーバを停止しました。 / HTTP server stopped.'));
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
      console.log('MongoDB接続を切断しました。 / MongoDB connection disconnected.');
    }
    if (client) {
      client.destroy();
      console.log('Discord クライアントを破棄しました。 / Discord client destroyed.');
    }
  } catch (e) {
    console.warn('接続切断でエラー:', e);
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('❌ 環境変数 MONGO_URI が設定されていません。 / ❌ The environment variable MONGO_URI is not set.');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDBに接続しました / ✅ Connected to MongoDB');
    if (TOKEN) {
      await client.login(TOKEN);
    } else {
      console.warn('DISCORD_TOKEN が設定されていません。Bot はログインしません（テストモード）。 / DISCORD_TOKEN is not set. The bot will not log in (test mode).');
    }
  } catch (err) {
    console.error('❌ MongoDBまたはDiscordへの接続エラー:', err);
    process.exit(1);
  }
})();