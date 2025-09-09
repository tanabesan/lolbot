// 修正後の subscribe.js
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const Subscription = mongoose.model('Subscription');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('新規コースの通知を設定します。 / Set up notifications for new courses.')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('通知を送るチャンネル / The channel to send notifications to.')
        .setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('通知時にメンションするロール（任意） / The role to mention in notifications (optional).')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    if (!interaction.member || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'コマンドを実行できるのは管理者のみです。 / Only administrators can execute this command.', flags: 64 });
    }

    if (!interaction.guild) {
      return interaction.reply({ content: 'ボットの参加しているサーバー内で実行してください。 / Please execute this command within a server the bot has joined.', flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('role', false);

    try {
      const doc = {
        guildId: interaction.guild.id,
        channelId: channel.id,
        roleId: role ? role.id : null
      };

      await Subscription.updateOne(
        { guildId: doc.guildId },
        { $set: doc },
        { upsert: true }
      );

      await interaction.editReply({ content: `✅ 登録しました: チャンネル ${channel} ${role ? `ロール ${role}` : ''} / ✅ Subscription registered: Channel ${channel} ${role ? `Role ${role}` : ''}` });
    } catch (err) {
      console.error('MongoDBへのデータ登録中にエラー:', err); // Error while registering data to MongoDB:
      await interaction.editReply({ content: 'データベースエラーが発生しました。 / A database error occurred.' });
    }
  }
};