const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unsubscribe')
    .setDescription('登録済みの通知（チャンネル+ロール）を解除します。ロール指定なしならそのチャンネルに紐づく全登録を削除します。')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('解除するチャンネル')
        .setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('解除するロール（省略可）')
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

    if (!interaction.guild) {
      return interaction.editReply({ content: 'サーバー内で実行してください。' });
    }

    const db = new Database('settings.db');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT,
          channel_id TEXT,
          role_id TEXT
        )
      `);

      let info;
      if (role) {
        const del = db.prepare('DELETE FROM subscriptions WHERE guild_id = ? AND channel_id = ? AND role_id = ?');
        info = del.run(interaction.guild.id, channel.id, role.id);
      } else {
        // ロール指定がなければそのチャンネルに紐づく全てを削除
        const del = db.prepare('DELETE FROM subscriptions WHERE guild_id = ? AND channel_id = ?');
        info = del.run(interaction.guild.id, channel.id);
      }

      if (info.changes && info.changes > 0) {
        await interaction.editReply({ content: `削除しました（${info.changes}件）。` });
      } else {
        await interaction.editReply({ content: '該当する登録が見つかりませんでした。' });
      }
    } catch (err) {
      console.error('unsubscribe コマンドで DB エラー:', err);
      await interaction.editReply({ content: '解除中にエラーが発生しました。' });
    } finally {
      try { db.close(); } catch(e){/* ignore */ }
    }
  }
};
