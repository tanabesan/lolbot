const { SlashCommandBuilder } = require('discord.js');
const mongoose = require('mongoose');

const YoutubeSubscription = mongoose.model('YoutubeSubscription');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('yt-list')
    .setDescription('このチャンネルに登録されているYouTube通知の一覧を表示します'),
  async execute(interaction) {
    const subs = await YoutubeSubscription.find({
      guildId: interaction.guildId,
      channelId: interaction.channelId
    });

    if (subs.length === 0) {
      await interaction.reply({ content: 'このチャンネルには登録されているYouTubeチャンネルはありません。', ephemeral: true });
      return;
    }

    const list = subs.map(s => `・\`${s.youtubeChannelId}\``).join('\n');
    await interaction.reply({ content: `📺 このチャンネルの登録一覧:\n${list}`, ephemeral: true });
  }
};
