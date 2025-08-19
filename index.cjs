// index.cjs

require('dotenv').config();

const fs = require('node:fs');

const path = require('node:path');

const https = require('https');

const { Client, Collection, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');



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



// ─── コマンド読み込み（スラッシュ用） ───

client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');

if (fs.existsSync(commandsDir)) {

  for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {

    const cmd = require(path.join(commandsDir, file));

    client.commands.set(cmd.data.name, cmd);

  }

}



// ─── ロビー取得・Leaderboard取得のヘルパー ───

function fetchLolBeansLobbyAsync() {

  return new Promise((res, rej) => {

    https.get('https://s.lolbeans.io/', r => {

      let d = '';

      r.on('data', c => d += c);

      r.on('end', () => {

        const parts = d.trim().split(/\s+/);

        if (parts.length >= 3) res({ sessionId: parts[2] });

        else rej(new Error('Unexpected lobby format'));

      });

    }).on('error', rej);

  });

}



function fetchLolBeansLeaderboardAsync(sessionId, c) {

  return new Promise((res, rej) => {

    const url = `https://s.lolbeans.io/leaderboards?s=${sessionId}&r=TOK&m=0&p=0&c=${c}`;

    https.get(url, r => {

      let b = '';

      r.on('data', c => b += c);

      r.on('end', () => {

        try {

          res(JSON.parse(b).values);

        } catch (e) {

          rej(e);

        }

      });

    }).on('error', rej);

  });

}



// ─── Ready ───

client.once('ready', () => {

  console.log(`Logged in as ${client.user.tag}!`);

});



// ─── Message コマンド（旧来の !ping, !leader）───

client.on('messageCreate', async msg => {

  if (msg.author.bot) return;

  if (!msg.content.startsWith(PREFIX)) return;



  const [cmd] = msg.content.slice(PREFIX.length).trim().split(/\s+/);



  if (cmd === 'ping') {

    return msg.reply('Pong！');

  }



 if (cmd === 'leader') {

   const loading = await msg.channel.send('LOLBeans情報取得中…');

   try {

     const { sessionId } = await fetchLolBeansLobbyAsync();

     // 今日分を取りたいとき：c=0

     const todayValues = await fetchLolBeansLeaderboardAsync(sessionId, 1);

     // 昨日までを取りたいとき：c=30

     const yesterdayValues = await fetchLolBeansLeaderboardAsync(sessionId, 30);



     // ここでは例として「今日分」を表示

     const values = todayValues;

 

     if (!values.length) {

       return loading.edit('📭 今日のリーダーボードにエントリーがありません。');

     }

 

     let text = `🏆 **今日のLOLBeans Leaderboard Top ${values.length}** 🏆\n`;

     values.forEach(([username, , wins], i) => {

       text += `\`${i + 1}.\` ${username || '(名無し)'} — ${wins} wins\n`;

     });

     loading.edit(text);

   } catch (e) {

     console.error(e);

     loading.edit('❌ 取得に失敗しました。');

   }

 }



});



// ─── Slash コマンドハンドラ (/leaderboard) ───

client.on('interactionCreate', async interaction => {

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);

  if (!command) return;



  try {

    await command.execute(interaction, fetchLolBeansLobbyAsync, fetchLolBeansLeaderboardAsync);

  } catch (err) {

    console.error(err);

    if (!interaction.replied) {

      await interaction.reply({ content: 'エラーが発生しました。', ephemeral: true });

    }

  }

});



// ─── ログイン ───

client.login(TOKEN);

