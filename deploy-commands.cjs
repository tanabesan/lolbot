// deploy-commands.cjs

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN) {
  console.error('環境変数 DISCORD_TOKEN が設定されていません。 .env を確認してください。');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('環境変数 CLIENT_ID が設定されていません。 .env を確認してください。');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

if (!fs.existsSync(commandsPath)) {
  console.error(`commands フォルダが見つかりません: ${commandsPath}`);
  process.exit(1);
}

const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  try {
    const command = require(filePath);
    if (command && command.data && typeof command.data.toJSON === 'function') {
      commands.push(command.data.toJSON());
    } else {
      console.warn(`[警告] ${filePath} に有効な SlashCommandBuilder (data) が見つかりません。`);
    }
  } catch (err) {
    console.error(`[エラー] ${filePath} の読み込みに失敗しました:`, err && err.message ? err.message : err);
  }
}

if (commands.length === 0) {
  console.log('登録するコマンドが見つかりませんでした。commands フォルダ内を確認してください。');
  process.exit(0);
}

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      console.log(`ギルド ${GUILD_ID} に対して ${commands.length} 個のコマンドを登録します（即時反映）。`);
      const data = await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log(`✅ ギルドコマンド登録完了: ${Array.isArray(data) ? data.length : 0} 個`);
    } else {
      console.log(`グローバルに ${commands.length} 個のコマンドを登録します（反映に時間がかかる場合があります）。`);
      const data = await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands }
      );
      console.log(`✅ グローバルコマンド登録完了: ${Array.isArray(data) ? data.length : 0} 個`);
    }
    process.exit(0);
  } catch (error) {
    console.error('コマンド登録中にエラーが発生しました:', error);
    process.exit(1);
  }
})();
