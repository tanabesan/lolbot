const { SlashCommandBuilder } = require('discord.js');
const mongoose = require('mongoose');

const YoutubeSubscription = mongoose.model('YoutubeSubscription');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('yt-unsubscribe')
    .setDescription('このチャンネルへの、指定したYouTubeチャンネルの通知登録を解除します')
    .addStringOption(option =>
      option.setName('channel_id')
        .setDescription('解除したいYouTubeチャンネルID（UCから始まるID）')
        .setRequired(true)
    ),
  async execute(interaction) {
    const youtubeChannelId = interaction.options.getString('channel_id').trim();

    const result = await YoutubeSubscription.deleteOne({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      youtubeChannelId
    });

    if (result.deletedCount === 0) {
      await interaction.reply({ content: 'ℹ️ このチャンネルには該当する登録が見つかりませんでした。', ephemeral: true });
      return;
    }

    await interaction.reply(`✅ YouTubeチャンネル \`${youtubeChannelId}\` の通知登録を解除しました。`);
  }
};
