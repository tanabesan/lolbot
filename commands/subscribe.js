const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('このサーバーで新規コースの通知を行うチャンネルと（任意で）ロールを登録します。')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('通知を送るチャンネル')
        .setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('通知時にメンションするロール（任意）')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // 管理権限チェック（Runtime）
    if (!interaction.member || !interaction.member.permissions || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply({ content: 'このコマンドを実行するには「サーバーの管理」権限が必要です。' });
    }

    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('role', false);

    // サーバーコンテキスト必須
    if (!interaction.guild) {
      return interaction.editReply({ content: 'サーバー内で実行してください。' });
    }

    // DB 操作
    const db = new Database('settings.db');
    try {
      // テーブルが無い場合でも安全のため作る
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT,
          channel_id TEXT,
          role_id TEXT
        )
      `);

      const insert = db.prepare('INSERT INTO subscriptions (guild_id, channel_id, role_id) VALUES (?, ?, ?)');
      insert.run(interaction.guild.id, channel.id, role ? role.id : null);

      await interaction.editReply({ content: `登録しました: チャンネル ${channel} ${role ? `ロール ${role}` : ''}` });
    } catch (err) {
      console.error('subscribe コマンドで DB エラー:', err);
      await interaction.editReply({ content: '登録中にエラーが発生しました。' });
    } finally {
      try { db.close(); } catch(e){/* ignore */ }
    }
  }
};
