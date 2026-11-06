// File: commands/convert.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const axios = require('axios');
const { convertImageToGlol } = require('../convert.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('convert')
    .setDescription('画像を.glolに変換します')
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('変換したい画像')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('width')
        .setDescription('グリッドの幅（省略時: 32。高さ省略なら縦横比を維持）')
        .setMinValue(1)
        .setMaxValue(256)
    )
    .addIntegerOption(option =>
      option.setName('height')
        .setDescription('グリッドの高さ（省略時: 縦横比を維持して自動）')
        .setMinValue(1)
        .setMaxValue(256)
    )
    .addNumberOption(option =>
      option.setName('saturation')
        .setDescription('彩度 0.5〜2（デフォルト: 1）')
        .setMinValue(0.5)
        .setMaxValue(2)
    )
    .addNumberOption(option =>
      option.setName('brightness')
        .setDescription('明度 0.5〜1.5（デフォルト: 1）')
        .setMinValue(0.5)
        .setMaxValue(1.5)
    )
    .addIntegerOption(option =>
      option.setName('colors')
        .setDescription('減色して色数を制限（省略時は減色なし。減らすとブロック数も減ります）')
        .setMinValue(2)
        .setMaxValue(256)
    )
    .addBooleanOption(option =>
      option.setName('keep_transparent')
        .setDescription('透明ピクセルもブロック化する（デフォルト: しない）')
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const attachment = interaction.options.getAttachment('image');
    if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
      return interaction.editReply('❌ 画像ファイルを指定してください。');
    }

    try {
      const response = await axios.get(attachment.url, { responseType: 'arraybuffer', timeout: 15000 });
      const result = await convertImageToGlol(Buffer.from(response.data), {
        width: interaction.options.getInteger('width') ?? undefined,
        height: interaction.options.getInteger('height') ?? undefined,
        saturation: interaction.options.getNumber('saturation') ?? 1,
        brightness: interaction.options.getNumber('brightness') ?? 1,
        maxColors: interaction.options.getInteger('colors') ?? undefined,
        keepTransparent: interaction.options.getBoolean('keep_transparent') ?? false,
        groupName: path.parse(attachment.name).name.slice(0, 40) || 'Converted'
      });

      const file = new AttachmentBuilder(Buffer.from(JSON.stringify(result.glol)), { name: 'converted.glol' });
      await interaction.editReply({
        content: `✅ 変換が完了しました！ ${result.width}×${result.height} → ブロック数 **${result.blockCount}**`,
        files: [file]
      });
    } catch (error) {
      console.error('変換中にエラー:', error);
      await interaction.editReply(`❌ 変換中にエラーが発生しました。\n\`\`\`${String(error.message).slice(0, 500)}\`\`\``);
    }
  },
};