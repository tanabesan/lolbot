const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
const Subscription = mongoose.model('Subscription');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unsubscribe')
    .setDescription('通知の登録を解除。 / Unsubscribe from notifications.')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('解除するチャンネル / The channel to unsubscribe from.')
        .setRequired(true)
    )
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('解除するロール（省略可） / The role to unsubscribe (optional).')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    if (!interaction.member || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply({ content: 'コマンドを実行できるのは管理者のみです。 / Only administrators can execute this command.' });
    }

    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('role', false);

    if (!interaction.guild) {
      return interaction.editReply({ content: 'ボットの参加しているサーバー内で実行してください。 / Please execute this command within a server the bot has joined.' });
    }

    try {
      let result;
      if (role) {
        result = await Subscription.deleteOne({
          guildId: interaction.guild.id,
          channelId: channel.id,
          roleId: role.id
        });
      } else {
        result = await Subscription.deleteMany({
          guildId: interaction.guild.id,
          channelId: channel.id
        });
      }

      if (result.deletedCount && result.deletedCount > 0) {
        await interaction.editReply({ content: `✅ 登録を解除しました（${result.deletedCount}件）。 / ✅ Unsubscribed (${result.deletedCount} entry(ies)).` });
      } else {
        await interaction.editReply({ content: '登録が見つかりませんでした。 / No registration was found.' });
      }
    } catch (err) {
      console.error('MongoDBからのデータ削除中にエラー:', err); // Error deleting data from MongoDB:
      await interaction.editReply({ content: 'データベースエラーが発生しました。 / A database error occurred.' });
    }
  }
};