// CHANGELOG.md を読み込んで、通知用の配列 [{version, date, title, changes[], important}] にする
const fs = require('node:fs');
const path = require('node:path');

function parseChangelog(text) {
  const entries = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+v?(\d+\.\d+\.\d+)\s*[（(]\s*(\d{4}-\d{2}-\d{2})\s*[)）]\s*(.*)$/);
    if (h) {
      let title = h[3].trim();
      const important = /\[important\]/i.test(title);
      title = title.replace(/\[important\]/ig, '').trim();
      cur = { version: h[1], date: h[2], title, changes: [], important };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const b = line.match(/^[-*]\s+(.*)$/);
    if (b) cur.changes.push(b[1].trim());
    else if (/^\s+\S/.test(line) && cur.changes.length > 0) cur.changes[cur.changes.length - 1] += ' ' + line.trim(); // 字下げの続き行
  }
  return entries.filter(e => e.changes.length > 0);
}

let entries = [];
try {
  entries = parseChangelog(fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'));
} catch (e) {
  console.warn('⚠️ CHANGELOG.md を読み込めませんでした（更新通知は無効）:', e.message);
}
module.exports = entries;