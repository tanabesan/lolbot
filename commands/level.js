// /level latest | search | random — コースを探すコマンド
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getLevels, searchLevels, typeLabel, playUrl, thumbUrl } = require('../levels-util.js');

const typeOption = o => o.setName('type').setDescription('コースの種類（省略時: 通常）')
  .addChoices({ name: '通常', value: 'normal' }, { name: 'Hardcore', value: 'hardcore' });

const clip = (s, n) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');
const line = (l, i) => `${i + 1}. [**${clip(l.name || '名前なし', 40)}**](${playUrl(l.levelId)}) — \`${clip(l.author || '不明', 24)}\` ｜ ${typeLabel(l.type)}`;

const listEmbed = (title, levels, footer) => new EmbedBuilder()
  .setColor(0x00FF00)
  .setTitle(title)
  .setDescription(levels.map(line).join('\n').slice(0, 4000))
  .setThumbnail(thumbUrl(levels[0].levelId))
  .setFooter({ text: footer });

module.exports = {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription('LOLBeansのコミュニティコースを探します')
    .addSubcommand(sub => sub.setName('latest').setDescription('最新のコースを表示します')
      .addIntegerOption(o => o.setName('count').setDescription('表示件数（1〜10、省略時: 5）').setMinValue(1).setMaxValue(10))
      .addStringOption(typeOption))
    .addSubcommand(sub => sub.setName('search').setDescription('コース名・作者・説明からコースを検索します')
      .addStringOption(o => o.setName('keyword').setDescription('検索ワード').setRequired(true).setMaxLength(50))
      .addStringOption(typeOption))
    .addSubcommand(sub => sub.setName('random').setDescription('ランダムなコースを1つ選びます')
      .addStringOption(typeOption)),

  async execute(interaction) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();
    const typeKey = interaction.options.getString('type') ?? 'normal';
    const typeText = typeKey === 'hardcore' ? 'Hardcore' : '通常';

    try {
      const levels = await getLevels(typeKey);
      if (levels.length === 0) return interaction.editReply('❌ コース一覧を取得できませんでした。時間をおいて再度お試しください。');

      if (sub === 'latest') {
        const count = interaction.options.getInteger('count') ?? 5;
        const list = levels.slice(0, count);
        return interaction.editReply({ embeds: [listEmbed(`🆕 最新のコース（${typeText}）`, list, '名前をクリックするとプレイページが開きます')] });
      }

      if (sub === 'search') {
        const keyword = interaction.options.getString('keyword', true);
        const hits = searchLevels(levels, keyword);
        if (hits.length === 0) return interaction.editReply(`🔍 「${clip(keyword, 30)}」に一致するコースは見つかりませんでした（${typeText}の新しい順 ${levels.length} 件から検索）。`);
        const list = hits.slice(0, 10);
        return interaction.editReply({
          embeds: [listEmbed(`🔍 「${clip(keyword, 30)}」の検索結果（${typeText}）`, list,
            `${hits.length} 件ヒット${hits.length > 10 ? '（上位10件を表示）' : ''} ｜ 新しい ${levels.length} 件から検索`)]
        });
      }

      // random
      const l = levels[Math.floor(Math.random() * levels.length)];
      const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`🎲 ${clip(l.name || '名前なし', 100)}`)
        .setDescription([`${typeLabel(l.type)} ｜ \`${l.author || '不明'}\``, l.description ? clip(l.description, 300) : ''].filter(Boolean).join('\n'))
        .setImage(thumbUrl(l.levelId))
        .setFooter({ text: `${typeText}の新しい ${levels.length} 件からランダム` });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('▶ プレイ').setStyle(ButtonStyle.Link).setURL(playUrl(l.levelId)));
      return interaction.editReply({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error('levelコマンドでエラー:', err);
      return interaction.editReply('❌ エラーが発生しました。時間をおいて再度お試しください。');
    }
  }
};