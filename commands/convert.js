// File: commands/convert.js
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const os = require('os');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('convert')
    .setDescription('画像を.glolファイルに変換。 / Converts image to a .glol file.')
    .addAttachmentOption(option =>
      option.setName('image')
        .setDescription('変換したい画像ファイル / The image file to convert.')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('width')
        .setDescription('変換後の幅 (デフォルト: 32) / Converted width (default: 32)')
        .setMinValue(1)
        .setMaxValue(256)
    )
    .addIntegerOption(option =>
      option.setName('height')
        .setDescription('変換後の高さ (デフォルト: 32) / Converted height (default: 32)')
        .setMinValue(1)
        .setMaxValue(256)
    )
    .addIntegerOption(option =>
      option.setName('colors')
        .setDescription('使える色の種類 (デフォルト: 15) / Number of colors to use (default: 15)')
        .setMinValue(1)
        .setMaxValue(256)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const attachment = interaction.options.getAttachment('image');
    const width = interaction.options.getInteger('width') ?? 32;
    const height = interaction.options.getInteger('height') ?? 32;
    const colors = interaction.options.getInteger('colors') ?? 15;

    const tempDir = os.tmpdir();
    const tempInPath = path.join(tempDir, `${Date.now()}_input${path.extname(attachment.name)}`);
    const tempOutPath = path.join(tempDir, `${Date.now()}_output.glol`);

    try {
      const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
      await fs.writeFile(tempInPath, response.data);

      await new Promise((resolve, reject) => {
        const scriptPath = path.join(process.cwd(), 'convert.js');
        
        const args = [
          scriptPath,
          '--input', tempInPath,
          '--output', tempOutPath,
          '--width', width,
          '--height', height,
          '--maxColors', colors
        ];

        execFile('node', args, (error, stdout, stderr) => {
          if (error) {
            console.error('Script stderr:', stderr);
            return reject(new Error(`スクリプト実行中にエラーが発生しました: ${stderr} / An error occurred during script execution: ${stderr}`));
          }
          console.log('Script stdout:', stdout);
          resolve();
        });
      });

      const file = new AttachmentBuilder(tempOutPath, { name: 'converted.glol' });
      await interaction.editReply({
        content: `✅ 変換が完了しました！ / ✅ Conversion complete!`,
        files: [file]
      });

    } catch (error) {
      console.error('変換中にエラー:', error); // Error during conversion:
      await interaction.editReply(`❌ 変換中にエラーが発生しました。\n\`\`\`${error.message}\`\`\` / ❌ An error occurred during conversion.\n\`\`\`${error.message}\`\`\``);
    } finally {
      await fs.unlink(tempInPath).catch(err => console.error('一時入力ファイルの削除に失敗:', err)); // Failed to delete temporary input file:
      await fs.unlink(tempOutPath).catch(err => console.error('一時出力ファイルの削除に失敗:', err)); // Failed to delete temporary output file:
    }
  },
};