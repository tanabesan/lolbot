require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const Database = require('better-sqlite3'); // SQLiteの移行用

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
// 'commands' ディレクトリが存在することを確認
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      try {
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
          client.commands.set(command.data.name, command);
        } else {
          console.log(`[警告] ${filePath} に必要な "data" または "execute" プロパティがありません。 / [WARNING] The file at ${filePath} is missing the required "data" or "execute" properties.`);
        }
      } catch (error) {
          console.error(`コマンドファイルの読み込み中にエラーが発生しました ${filePath}:`, error);
      }
    }
} else {
    console.warn('[警告] commands ディレクトリが見つかりませんでした。スラッシュコマンドは動作しません。 / [WARNING] The commands directory was not found. Slash commands will not work.');
}


// ─── データ移行 / Data Migration ───
const migrateFromOldSources = async () => {
  try {
    // SQLiteからのデータ移行 / Data migration from SQLite
    if (fs.existsSync('settings.db')) {
      console.log('SQLiteからMongoDBへデータを移行中... / Migrating data from SQLite to MongoDB...');
      
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
    console.error('❌ SQLiteからのデータ移行中にエラーが発生しました:', e);
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
    console.error('❌ JSONファイルからのデータ移行中にエラーが発生しました:', e);
  } finally {
    if (fs.existsSync('last_levels.json')) {
      fs.unlinkSync('last_levels.json');
      console.log('✔ last_levels.jsonを削除しました。 / ✔ last_levels.json has been deleted.');
    }
  }
};

// ─── 新しいレベル検知・通知ロジック / New Level Detection and Notification Logic ───
// コースの種類と対応するカスタム絵文字のIDを定義
const CUSTOM_EMOJIS = {
  // 【⚠️カスタム絵文字IDをBotが使用できるIDに置き換えてください！】
  // 以下の名前は仮です。Botがアクセスできるカスタム絵文字の名前とIDを使用してください。
  0: { name: 'sandbox',    id: '1437504794557153430' }, // Sandbox用カスタム絵文字ID
  1: { name: 'timed',      id: '1437504792451747901' }, // Timed Race用カスタム絵文字ID
  2: { name: 'competitive',id: '1437504797547696188' }, // Competitive Race用カスタム絵文字ID
  3: { name: 'elimination',id: '1437504795899330560' }  // Elimination用カスタム絵文字ID
};

// コースの種類と対応する絵文字（文字列）を定義
const LEVEL_TYPES = {
  // `<:name:id>` 形式でカスタム絵文字の文字列を作成
  0: `<:${CUSTOM_EMOJIS[0].name}:${CUSTOM_EMOJIS[0].id}> サンドボックス (Sandbox)`,
  1: `<:${CUSTOM_EMOJIS[1].name}:${CUSTOM_EMOJIS[1].id}> タイムレース (Timed Race)`,
  2: `<:${CUSTOM_EMOJIS[2].name}:${CUSTOM_EMOJIS[2].id}> 対戦レース (Competitive Race)`,
  3: `<:${CUSTOM_EMOJIS[3].name}:${CUSTOM_EMOJIS[3].id}> エリミネーション (Elimination)`
};

const checkNewLevels = async () => {
  console.log("新しいレベルをチェック中... / Checking for new levels...");
  try {
    const response = await axios.get(API_URL, { timeout: 10000 });
    const currentLevels = response.data;
    if (!currentLevels || !Array.isArray(currentLevels)) {
      console.warn('APIから予期しないデータを受信しました。 / Received unexpected data from API.');
      return;
    }

    const currentLevelIds = new Set(currentLevels.map(l => l.levelId.toString()));
    const lastLevels = await LastLevel.find({});
    const lastLevelIdSet = new Set(lastLevels.map(l => l.levelId));

    // 新しいレベルを見つける
    const newLevels = currentLevels.filter(level => !lastLevelIdSet.has(level.levelId.toString()));

    if (newLevels.length > 0) {
      console.log(`✅ ${newLevels.length} 件の新しいレベルが見つかりました! / ${newLevels.length} new levels found!`);
      await notifyNewLevels(newLevels);

      // 新しいレベルのIDをDBに保存するために、DBをクリアし、現在の全レベルを保存する
      await LastLevel.deleteMany({});
      const docs = Array.from(currentLevelIds).map(id => ({ levelId: id }));
      await LastLevel.insertMany(docs, { ordered: false });
    }
  } catch (error) {
    console.error('❌ 新規レベルチェック中にエラーが発生しました:', error && error.message ? error.message : error);
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
        // コースの種類を決定 (不明な場合はデフォルト値)
        const courseType = LEVEL_TYPES[level.type] || '❓ 不明 (Unknown)';

        const embed = new EmbedBuilder()
          .setTitle("新しいコースが追加されました！ 🌟")
          .setDescription(`**${level.name || '名前なし'}**`)
          .setColor(0x00FF00)
          .setThumbnail(`https://lolbeans.io/ui/level-thumbnails/${level.levelId}.png`)
          .addFields(
            // 🚨 コース種類フィールドをここに追加
            { name: "🏷️ コース種類", value: `**${courseType}**`, inline: true },
            { name: "✏️ 作者", value: `\`${level.author || '不明'}\``, inline: true },
            // ------------------------------------
            { name: "📄 説明", value: level.description || 'なし', inline: false }
          );
        
        await channel.send({ content: `${roleMention} 新規コースのお知らせです！`, embeds: [embed] });
      }
    } catch (error) {
      // チャンネルが存在しない、権限がないなどのエラー
      console.error(`サーバーID ${settings.guildId} への通知送信中にエラー:`, error && error.message ? error.message : error);
    }
  }
};

// ─── イベントハンドラ / Event Handlers ───
client.once('ready', async () => {
  console.log(`✅ Botが ${client.user.tag} としてログインしました! / Bot logged in as ${client.user.tag}!`);

  // 起動時にデータ移行を実行
  await migrateFromOldSources();

  // 起動時に最初のチェックを実行し、その後インターバルを設定
  await checkNewLevels();
  setInterval(checkNewLevels, CHECK_INTERVAL);

  // コマンドの登録をリマインド
  console.log('⚠️ スラッシュコマンドを使用するには、別途 deploy-commands.js を実行する必要があります。 / ⚠️ You need to run deploy-commands.js separately to use slash commands.');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    console.error(`"${interaction.commandName}" というコマンドは見つかりませんでした。 / Command "${interaction.commandName}" not found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`コマンド実行中にエラーが発生: ${interaction.commandName}`, error);
    // すでに deferReply や reply がされているかチェック
    const isDeferredOrReplied = interaction.deferred || interaction.replied;

    const errorMessage = 'コマンド実行中にエラーが発生しました！ / There was an error while executing this command!';
    
    if (isDeferredOrReplied) {
      await interaction.editReply({ content: errorMessage, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
    }
  }
});

// ─── ヘルスチェックとシャットダウン処理 / Health Check and Shutdown ───
const app = express();
app.get('/', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
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
    console.log('✅ MongoDBに接続しました。 / Connected to MongoDB.');
    
    // Discordにログイン
    await client.login(TOKEN);
  } catch (error) {
    console.error('致命的なエラー: 接続またはログインに失敗しました。', error);
    process.exit(1);
  }
})();