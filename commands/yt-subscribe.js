const { SlashCommandBuilder, ChannelType } = require('discord.js');
const mongoose = require('mongoose');

// index.cjs 側で定義済みの YoutubeSubscription モデルをここでも取得する
const YoutubeSubscription = mongoose.model('YoutubeSubscription');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('yt-subscribe')
    .setDescription('指定したYouTubeチャンネルの新着動画を、このコマンドを実行したチャンネルに通知します')
    .addStringOption(option =>
      option.setName('channel_id')
        .setDescription('YouTubeチャンネルID（UCから始まるID。ハンドル(@名前)は不可）')
        .setRequired(true)
    )
    .addChannelOption(option =>
      option.setName('target_channel')
        .setDescription('通知を送るDiscordチャンネル（指定しない場合はこのチャンネル）')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    ),
  async execute(interaction) {
    const youtubeChannelId = interaction.options.getString('channel_id').trim();
    const targetChannel = interaction.options.getChannel('target_channel') ?? interaction.channel;

    if (!/^UC[a-zA-Z0-9_-]{22}$/.test(youtubeChannelId)) {
      await interaction.reply({
        content: '❌ YouTubeチャンネルIDの形式が正しくないようです。`UC`から始まる24文字のIDを指定してください。\n（チャンネルのURLが `@名前` 形式の場合は、概要ページのソースなどからチャンネルIDを確認してください）',
        ephemeral: true
      });
      return;
    }

    const existing = await YoutubeSubscription.findOne({
      guildId: interaction.guildId,
      channelId: targetChannel.id,
      youtubeChannelId
    });

    if (existing) {
      await interaction.reply({ content: `ℹ️ このチャンネルは既に${targetChannel}に登録されています。`, ephemeral: true });
      return;
    }

    await YoutubeSubscription.create({
      guildId: interaction.guildId,
      channelId: targetChannel.id,
      youtubeChannelId
    });

    await interaction.reply(`✅ YouTubeチャンネル \`${youtubeChannelId}\` の新着動画を${targetChannel}に通知するよう登録しました。`);
  }
};