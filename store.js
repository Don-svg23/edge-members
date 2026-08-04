const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function fileFor(email) {
  const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);
  return path.join(DATA_DIR, `${hash}.json`);
}

function loadMember(email) {
  const file = fileFor(email);
  if (!fs.existsSync(file)) return { trades: [], courseProgress: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { trades: [], courseProgress: [] };
  }
}

function saveMember(email, data) {
  fs.writeFileSync(fileFor(email), JSON.stringify(data, null, 2));
}

module.exports = { loadMember, saveMember };
