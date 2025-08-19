// commands/leaderboard.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js'); // EmbedBuilder をインポート
const https = require('https');

// 各オプションの選択肢を定義
const regionChoices = [
  { name: 'Asia East', value: 'TOK' },
  { name: 'Australia', value: 'AU' },
  { name: 'US East', value: 'USE' },
  { name: 'Europe West', value: 'EUW' },
  { name: 'US West', value: 'USW' },
  { name: 'Asia SouthEast', value: 'SIN' },
  { name: 'South America', value: 'SA' }
];

const timeframeChoices = [
  { name: 'デイリー', value: '0' },
  { name: 'ウィークリー', value: '1' },
  { name: 'マンスリー', value: '2' }
];

const whenChoices = [
  { name: '現在', value: '1' },
  { name: '過去', value: '0' }
];


module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('LOLBeans のリーダーボードを表示します')
    .addStringOption(opt =>
      opt.setName('region')
        .setDescription('地域を選択してください')
        .setRequired(true)
        .addChoices(...regionChoices)
    )
    .addStringOption(opt =>
      opt.setName('timeframe')
        .setDescription('集計期間を選択してください')
        .setRequired(true)
        .addChoices(...timeframeChoices)
    )
    .addStringOption(opt =>
      opt.setName('when')
        .setDescription('いつのランキングを表示しますか')
        .setRequired(true)
        .addChoices(...whenChoices)
    ),
  async execute(interaction) {
    try {
      await interaction.deferReply();

      // ロビー取得
      const sessionId = await new Promise((res, rej) => {
        https.get('https://s.lolbeans.io/', r => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => {
            const parts = d.trim().split(/\s+/);
            if (parts.length >= 3) res(parts[2]);
            else rej(new Error('Unexpected lobby format'));
          });
        }).on('error', rej);
      });

      // オプション取得
      const region = interaction.options.getString('region');
      const pParam = interaction.options.getString('timeframe');
      const cParam = interaction.options.getString('when');

      // リーダーボード取得
      const values = await new Promise((res, rej) => {
        const url = `https://s.lolbeans.io/leaderboards?s=${sessionId}&r=${region}&m=0&p=${pParam}&c=${cParam}`;
        https.get(url, r => {
          let b = '';
          r.on('data', c => b += c);
          r.on('end', () => {
            try { res(JSON.parse(b).values); }
            catch (e) { rej(e); }
          });
        }).on('error', rej);
      });

      // ユーザーが選択したオプションの表示名を取得
      const regionText = regionChoices.find(c => c.value === region).name;
      const timeframeText = timeframeChoices.find(c => c.value === pParam).name;
      const whenText = whenChoices.find(c => c.value === cParam).name;

      // エントリーがない場合は、埋め込みでエラーメッセージを送信
      if (!values || !values.length) {
        const noEntryEmbed = new EmbedBuilder()
          .setColor(0xFF0000) // 赤色
          .setTitle('📭 エントリーが見つかりません')
          .setDescription(`**${regionText}** の **${whenText}** の **${timeframeText}** ランキングにエントリーがありませんでした。`);
        return interaction.editReply({ embeds: [noEntryEmbed] });
      }

      // ランキングリストの文字列を生成
      const leaderboardDescription = values
        .map(([username, , wins], i) => {
          // ユーザー名が空、またはnullの場合は '(名無し)' を使用
          const displayName = username || '(名無し)';
          return `\`${i + 1}.\` **${displayName}** — ${wins} wins`;
        })
        .join('\n'); // 配列を改行で連結して一つの文字列にする

      // リーダーボードの埋め込みを作成
      const leaderboardEmbed = new EmbedBuilder()
        .setColor(0xFFFF00) // 黄色
        .setTitle(`🏆 LOLBeans Leaderboard 🏆`)
        .setDescription(leaderboardDescription)
        .addFields(
          { name: 'Region', value: regionText, inline: true },
          { name: 'Timeframe', value: timeframeText, inline: true },
          { name: 'Period', value: whenText, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'Powered by LOLBeans API' });

      // 埋め込みを送信
      await interaction.editReply({ embeds: [leaderboardEmbed] });

    } catch (error) {
      console.error('Error executing leaderboard command:', error);
      // エラーが発生した場合もユーザーにフィードバック
      const errorEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ エラーが発生しました')
        .setDescription('リーダーボードの取得中に問題が発生しました。時間をおいて再度お試しください。');
      // deferReply の後なので、editReply を使用
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [errorEmbed], content: '' });
      } else {
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }
  }
};