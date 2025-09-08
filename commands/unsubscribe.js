const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const mongoose = require('mongoose');

// MongoDBモデルにアクセスするために、Mongooseを直接使用
const Subscription = mongoose.model('Subscription');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unsubscribe')
    .setDescription('新コミュ通知の登録を解除します。')
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

    if (!interaction.member || !interaction.member.permissions || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply({ content: 'コマンドを実行できるのは管理権限を持っているユーザーのみです。' });
    }

    if (!interaction.guild) {
      return interaction.editReply({ content: 'ボットの参加しているサーバー内で実行してください。' });
    }

    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('role', false);

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

      if (result.deletedCount > 0) {
        await interaction.editReply({ content: `✅ ${result.deletedCount}件の通知登録を解除しました。` });
      } else {
        await interaction.editReply({ content: 'このチャンネルには新コミュ通知の登録はありませんでした。' });
      }
    } catch (e) {
      console.error('MongoDB 操作エラー:', e);
      await interaction.editReply({ content: '解除中にエラーが発生しました。', ephemeral: true });
    }
  },
};