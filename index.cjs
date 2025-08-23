// index.cjs
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
// https は axios に置き換えるので不要になります
const express = require('express');
const { Client, Collection, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
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

// ─── データベース初期設定 (ここから追加) ───
const db = new Database('settings.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    channel_id TEXT,
    role_id TEXT
  )
`);

// 以前のバージョンで guilds テーブルを使っていた場合は自動移行する
try {
  const old = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='guilds'").get();
  if (old) {
    const rows = db.prepare('SELECT * FROM guilds').all();
    const insert = db.prepare('INSERT OR IGNORE INTO subscriptions (guild_id, channel_id, role_id) VALUES (?, ?, ?)');
    for (const r of rows) {
      insert.run(r.guild_id, r.channel_id, r.role_id);
    }
    db.exec('DROP TABLE IF EXISTS guilds');
    console.log('旧テーブル guilds から subscriptions へデータ移行を行いました。');
  }
} catch (e) {
  console.warn('データベース移行中にエラー:', e);
}

// 最後にチェックしたレベルIDを保存するファイル
const LAST_LEVELS_FILE = "last_levels.json";
const API_URL = "https://s.lolbeans.io/level-list?i=0&t=1&n=10&m";
const CHECK_INTERVAL = 10 * 60 * 1000; // 10分

// --- ファイル読み書きヘルパー (追加) ---
const loadLastLevels = () => {
  try {
    if (fs.existsSync(LAST_LEVELS_FILE)) {
      const data = fs.readFileSync(LAST_LEVELS_FILE, 'utf-8');
      return new Set(JSON.parse(data));
    }
  } catch (error) {
    console.error("last_levels.json の読み込みに失敗:", error);
  }
  return new Set();
};

const saveLastLevels = (levelIds) => {
  fs.writeFileSync(LAST_LEVELS_FILE, JSON.stringify([...levelIds]));
};
// (ここまで追加)


// ─── コマンド読み込み（スラッシュ用） ───
client.commands = new Collection();
const commandsDir = path.join(__dirname, 'commands');
if (fs.existsSync(commandsDir)) {
  for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
    const cmd = require(path.join(commandsDir, file));
    if (cmd && cmd.data && cmd.data.name) client.commands.set(cmd.data.name, cmd);
  }
}

// ─── ロビー取得・Leaderboard取得のヘルパー ───
/**
 * ロビー情報を取得するヘルパー
 * @param {string} levelIdOrCode
 * @returns {Promise<object|null>}
 */
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
      // 次の候補へ（ログは控えめ）
    }
  }
  return null;
}

/**
 * 指定レベルのリーダーボードを取得するヘルパー
 * @param {string|number} levelId
 * @returns {Promise<object|null>}
 */
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


// --- 新規コースチェック＆通知ロジック (ここから追加) ---
const checkNewLevels = async () => {
  console.log("新しいレベルをチェック中...");
  try {
    const response = await axios.get(API_URL, { timeout: 10000 });
    if (response.status !== 200 || !response.data || !response.data.l) {
      console.log("API レスポンスが想定と異なります。");
      return;
    }
    
    const levels = response.data.l;
    const currentLevelIds = new Set(levels.map(level => level.levelId));
    const lastLevelIds = loadLastLevels();
    
    const newLevelIds = [...currentLevelIds].filter(id => !lastLevelIds.has(id));

    if (newLevelIds.length > 0) {
      console.log(`${newLevelIds.length}件の新しいレベルが見つかりました！`);
      const newLevels = levels.filter(level => newLevelIds.includes(level.levelId));
      await notifyNewLevels(newLevels);
      saveLastLevels(currentLevelIds);
    } else {
      console.log("新しいレベルはありませんでした。");
    }
  } catch (error) {
    console.error("レベルチェック中にエラーが発生しました:", error && error.message ? error.message : error);
  }
};

const notifyNewLevels = async (newLevels) => {
  // subscriptions テーブルから channel_id が設定されているものを全部取る
  const allSubs = db.prepare('SELECT * FROM subscriptions WHERE channel_id IS NOT NULL').all();
  
  for (const settings of allSubs) {
    try {
      const channel = await client.channels.fetch(settings.channel_id);
      if (!channel) continue;

      const roleMention = settings.role_id ? `<@&${settings.role_id}>` : "";
      
      // levelId が数値や文字列のどちらでもソートできるようにしておく
      const sorted = newLevels.slice().sort((a, b) => {
        const ai = Number(a.levelId) || 0;
        const bi = Number(b.levelId) || 0;
        return ai - bi;
      });

      for (const level of sorted) {
        const embed = new EmbedBuilder()
          .setTitle("新しいコースが追加されました！ 🌟")
          .setDescription(`**${level.name || '名前なし'}**`)
          .setColor(0x00FF00) // 緑色
          .setThumbnail(`https://lolbeans.io/ui/level-thumbnails/${level.levelId}.png`)
          .addFields(
            { name: "✏️ 作者", value: `\`${level.author || '不明'}\``, inline: false },
            { name: "📄 説明", value: level.description || 'なし', inline: false }
          );
        
        await channel.send({ content: `${roleMention} 新規コースのお知らせです！`, embeds: [embed] });
      }
    } catch (error) {
      console.error(`サーバーID ${settings.guild_id} への通知送信中にエラー:`, error && error.message ? error.message : error);
    }
  }
};
// (ここまで追加)


// ─── Ready ───
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  // --- 定期実行タスクを開始 (ここを追記) ---
  checkNewLevels(); // 起動時に一度実行
  setInterval(checkNewLevels, CHECK_INTERVAL);
});

// ─── Message コマンド（旧来の !ping, !leader）───
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
    // 使い方: !leader <levelId>
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

      // data の構造が不明な場合に備え、適切にフォーマットして返す
      // ここでは想定される field を柔軟に処理する
      let desc = '';
      if (Array.isArray(data.entries)) {
        desc = data.entries.slice(0, 10).map((e, i) => `${i+1}. ${e.name || e.player || 'Unknown'} - ${e.time || e.score || ''}`).join('\n');
      } else if (Array.isArray(data.list)) {
        desc = data.list.slice(0, 10).map((e, i) => `${i+1}. ${e.name || e.player || 'Unknown'} - ${e.time || e.score || ''}`).join('\n');
      } else {
        // フラットなオブジェクトなら JSON.stringify の先頭だけ見せる
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
    // 既存のLeaderboardコマンドとの互換性を保つ
    if (command.data.name === 'leaderboard') {
        await command.execute(interaction, fetchLolBeansLobbyAsync, fetchLolBeansLeaderboardAsync);
    } else {
        // 新しいコマンドは interaction のみ渡す
        await command.execute(interaction);
    }
  } catch (err) {
    console.error(err);
    // 応答済みかチェックしてから返信する
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
    try {
      db.close();
      console.log('データベースをクローズしました。');
    } catch (e) {
      console.warn('データベースクローズでエラー:', e);
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
  // 可能ならシャットダウン
  shutdown();
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
