const { SlashCommandBuilder } = require('discord.js');
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
    ),
  async execute(interaction) {
    const youtubeChannelId = interaction.options.getString('channel_id').trim();

    if (!/^UC[a-zA-Z0-9_-]{22}$/.test(youtubeChannelId)) {
      await interaction.reply({
        content: '❌ YouTubeチャンネルIDの形式が正しくないようです。`UC`から始まる24文字のIDを指定してください。\n（チャンネルのURLが `@名前` 形式の場合は、概要ページのソースなどからチャンネルIDを確認してください）',
        ephemeral: true
      });
      return;
    }

    const existing = await YoutubeSubscription.findOne({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      youtubeChannelId
    });

    if (existing) {
      await interaction.reply({ content: 'ℹ️ このチャンネルは既にこのDiscordチャンネルに登録されています。', ephemeral: true });
      return;
    }

    await YoutubeSubscription.create({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      youtubeChannelId
    });

    await interaction.reply(`✅ YouTubeチャンネル \`${youtubeChannelId}\` の新着動画をこのチャンネルに通知するよう登録しました。`);
  }
};
