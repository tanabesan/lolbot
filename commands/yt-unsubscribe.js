const { SlashCommandBuilder, ChannelType } = require('discord.js');
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
    )
    .addChannelOption(option =>
      option.setName('target_channel')
        .setDescription('解除対象のDiscordチャンネル（指定しない場合はこのチャンネル）')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    ),
  async execute(interaction) {
    const youtubeChannelId = interaction.options.getString('channel_id').trim();
    const targetChannel = interaction.options.getChannel('target_channel') ?? interaction.channel;

    const result = await YoutubeSubscription.deleteOne({
      guildId: interaction.guildId,
      channelId: targetChannel.id,
      youtubeChannelId
    });

    if (result.deletedCount === 0) {
      await interaction.reply({ content: `ℹ️ ${targetChannel}には該当する登録が見つかりませんでした。`, ephemeral: true });
      return;
    }

    await interaction.reply(`✅ YouTubeチャンネル \`${youtubeChannelId}\` の${targetChannel}への通知登録を解除しました。`);
  }
};