// /youtube add | remove | list — YouTube新着通知の管理（旧 yt-subscribe / yt-unsubscribe / yt-list を統合）
// チャンネルは UC...のID・@ハンドル・チャンネルURL のどれでも指定できる
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const mongoose = require('mongoose');
const { resolveYoutubeChannel } = require('../youtube-util.js');
const YoutubeSubscription = mongoose.model('YoutubeSubscription');

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const MAX_PER_GUILD = 20;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('youtube')
    .setDescription('YouTube新着動画の通知設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('YouTubeチャンネルの新着動画を通知します')
      .addStringOption(o => o.setName('channel').setDescription('@ハンドル / チャンネルURL / UCから始まるID').setRequired(true))
      .addChannelOption(o => o.setName('target').setDescription('通知先（省略時はこのチャンネル）').addChannelTypes(...TEXT_TYPES)))
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('YouTube通知を解除します')
      .addStringOption(o => o.setName('channel').setDescription('解除するYouTubeチャンネル（候補から選択／@ハンドル／ID）').setRequired(true).setAutocomplete(true))
      .addChannelOption(o => o.setName('target').setDescription('このチャンネルへの通知だけ解除（省略時はサーバー内すべて）').addChannelTypes(...TEXT_TYPES)))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('このサーバーのYouTube通知一覧を表示します')),

  // 解除時の候補表示（登録済みのチャンネル名を出す）
  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const subs = await YoutubeSubscription.find({ guildId: interaction.guildId });
    const seen = new Map();
    for (const s of subs) if (!seen.has(s.youtubeChannelId)) seen.set(s.youtubeChannelId, s.title || s.youtubeChannelId);
    const choices = [...seen].map(([id, title]) => ({ name: `${title}`.slice(0, 90) + ` (${id.slice(0, 8)}…)`, value: id }))
      .filter(c => c.name.toLowerCase().includes(typed) || c.value.toLowerCase().includes(typed))
      .slice(0, 25);
    await interaction.respond(choices);
  },

  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'コマンドを実行できるのは、サーバーの管理権限を持つ人のみです。', flags: 64 });
    }
    await interaction.deferReply({ flags: 64 });
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    try {
      if (sub === 'list') {
        const subs = await YoutubeSubscription.find({ guildId });
        if (subs.length === 0) return interaction.editReply('このサーバーには登録されているYouTubeチャンネルはありません。');
        const lines = subs.map(s => `・[${s.title || s.youtubeChannelId}](https://www.youtube.com/channel/${s.youtubeChannelId}) → <#${s.channelId}>`);
        return interaction.editReply(`📺 登録一覧（${subs.length}件）\n${lines.join('\n')}`.slice(0, 1900));
      }

      const resolved = await resolveYoutubeChannel(interaction.options.getString('channel', true));
      if (!resolved) {
        return interaction.editReply('❌ YouTubeチャンネルが見つかりません。`@ハンドル`、チャンネルURL、`UC`から始まるIDのいずれかを指定してください。');
      }
      const target = interaction.options.getChannel('target') ?? interaction.channel;

      if (sub === 'add') {
        const count = await YoutubeSubscription.countDocuments({ guildId });
        const existing = await YoutubeSubscription.findOne({ guildId, channelId: target.id, youtubeChannelId: resolved.id });
        if (existing) return interaction.editReply(`ℹ️ **${resolved.title || resolved.id}** は既に${target}に登録されています。`);
        if (count >= MAX_PER_GUILD) return interaction.editReply(`❌ 1サーバーあたりの上限（${MAX_PER_GUILD}件）に達しています。`);

        await YoutubeSubscription.create({ guildId, channelId: target.id, youtubeChannelId: resolved.id, title: resolved.title });
        return interaction.editReply(`✅ **${resolved.title || resolved.id}** の新着動画を${target}に通知します。`);
      }

      // remove
      const filter = { guildId, youtubeChannelId: resolved.id };
      if (interaction.options.getChannel('target')) filter.channelId = target.id;
      const result = await YoutubeSubscription.deleteMany(filter);
      return interaction.editReply(result.deletedCount
        ? `✅ **${resolved.title || resolved.id}** の通知登録を解除しました（${result.deletedCount}件）。`
        : 'ℹ️ 該当する登録が見つかりませんでした。');
    } catch (err) {
      console.error('youtubeコマンドでエラー:', err);
      return interaction.editReply('エラーが発生しました。時間をおいて再度お試しください。');
    }
  }
};