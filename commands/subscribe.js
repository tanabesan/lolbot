// 修正後の subscribe.js
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const mongoose = require('mongoose');
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
    // 権限チェックはdeferReplyの前に行う
    if (!interaction.member || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      // 権限がない場合は即座にreply
      return interaction.reply({ content: 'このコマンドを実行するには「サーバーの管理」権限が必要です。', flags: 64 });
    }

    if (!interaction.guild) {
      // サーバー外の場合は即座にreply
      return interaction.reply({ content: 'サーバー内で実行してください。', flags: 64 });
    }

    // すべての前提条件を満たした場合のみ deferReply を実行
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

      await interaction.editReply({ content: `✅ 登録しました: チャンネル ${channel} ${role ? `ロール ${role}` : ''}` });
    } catch (err) {
      console.error('MongoDBへのデータ登録中にエラー:', err);
      // エラーが起きた場合は、必ず editReply を使用してユーザーに知らせる
      await interaction.editReply({ content: 'データベースエラーが発生しました。' });
    }
  }
};