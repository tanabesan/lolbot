const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const mongoose = require('mongoose');

// MongoDBモデルにアクセスするために、Mongooseを直接使用
const Subscription = mongoose.model('Subscription');

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

    if (!interaction.member || !interaction.member.permissions || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply({ content: 'コマンドを実行できるのは管理権限を持っているユーザーのみです。' });
    }

    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('role', false);

    if (!interaction.guild) {
      return interaction.editReply({ content: 'ボットの参加しているサーバー内で実行してください。' });
    }

    try {
      const doc = await Subscription.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { channelId: channel.id, roleId: role ? role.id : null },
        { upsert: true, new: true }
      );
      await interaction.editReply({ content: `✅ 通知を登録しました: チャンネル ${channel} ${role ? `ロール ${role}` : ''}` });
    } catch (e) {
      console.error('MongoDB 操作エラー:', e);
      await interaction.editReply({ content: '登録中にエラーが発生しました。', ephemeral: true });
    }
  },
};