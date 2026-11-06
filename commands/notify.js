// /notify set | remove  — 新規コース通知の登録・解除（旧 /subscribe と /unsubscribe を統合）
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const mongoose = require('mongoose');
const Subscription = mongoose.model('Subscription');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('notify')
    .setDescription('新規コミュニティレベルの通知設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('通知を送るチャンネルを設定します（再実行で上書き）')
      .addChannelOption(o => o.setName('channel').setDescription('通知を送るチャンネル')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addRoleOption(o => o.setName('role').setDescription('通知時にメンションするロール（任意）')))
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('このサーバーの通知設定を解除します')),

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'コマンドを実行できるのは、サーバーの管理権限を持つ人のみです。', flags: 64 });
    }
    await interaction.deferReply({ flags: 64 });

    try {
      if (interaction.options.getSubcommand() === 'set') {
        const channel = interaction.options.getChannel('channel', true);
        const role = interaction.options.getRole('role', false);
        await Subscription.updateOne(
          { guildId: interaction.guildId },
          { $set: { guildId: interaction.guildId, channelId: channel.id, roleId: role ? role.id : null } },
          { upsert: true }
        );
        return interaction.editReply(`✅ 登録しました: ${channel}${role ? ` ／ ロール ${role}` : ''}`);
      }

      const result = await Subscription.deleteOne({ guildId: interaction.guildId });
      return interaction.editReply(result.deletedCount ? '✅ このサーバーの通知登録を解除しました。' : '登録が見つかりませんでした。');
    } catch (err) {
      console.error('notifyコマンドでDBエラー:', err);
      return interaction.editReply('データベースエラーが発生しました。');
    }
  }
};