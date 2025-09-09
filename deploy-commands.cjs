require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

// MongoDB スキーマとモデルを定義
const SubscriptionSchema = new mongoose.Schema({
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    roleId: { type: String, default: null }
});
const Subscription = mongoose.model('Subscription', SubscriptionSchema);

// MongoDBに接続
(async () => {
    if (!process.env.MONGO_URI) {
        console.error('❌ 環境変数 MONGO_URI が設定されていません。');
        process.exit(1);
    }
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDBに接続しました');
    } catch (err) {
        console.error('❌ MongoDBへの接続エラー:', err);
        process.exit(1);
    }
})();


const commands = [];
// commands ディレクトリ内のすべてのコマンドファイルを読み込みます
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	commands.push(command.data.toJSON());
}

// RESTモジュールのインスタンスを準備します
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// コマンドをデプロイします
(async () => {
	try {
		console.log(`グローバルに ${commands.length} 個のコマンドを登録します（反映に時間がかかる場合があります）。`);

		const data = await rest.put(
			Routes.applicationCommands(process.env.CLIENT_ID),
			{ body: commands },
		);

		console.log(`✅ グローバルコマンド登録完了: ${data.length} 個`);
	} catch (error) {
		console.error(error);
	}
})();