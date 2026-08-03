const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const mongoose = require('mongoose');
const Subscription = mongoose.model('Subscription');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unsubscribe')
    .setDescription('このサーバーの通知登録を解除します。')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    if (!interaction.member || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply({ content: 'コマンドを実行できるのは管理者のみです。' });
    }

    if (!interaction.guild) {
      return interaction.editReply({ content: 'ボットの参加しているサーバー内で実行してください。' });
    }

    try {
      const result = await Subscription.deleteOne({ guildId: interaction.guild.id });

      if (result.deletedCount && result.deletedCount > 0) {
        await interaction.editReply({ content: '✅ このサーバーの通知登録を解除しました。' });
      } else {
        await interaction.editReply({ content: '登録が見つかりませんでした。' });
      }
    } catch (err) {
      console.error('MongoDBからのデータ削除中にエラー:', err);
      await interaction.editReply({ content: 'データベースエラーが発生しました。' });
    }
  }
};