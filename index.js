// index.js
require('dotenv').config?.(); // optional if dotenv present (Render env vars kaam karte hain)
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

// ===== CONFIG =====
const TOKEN = process.env.BOT_TOKEN; // Render Env Var: BOT_TOKEN
if (!TOKEN) {
  console.error('❌ BOT_TOKEN missing in environment variables');
  process.exit(1);
}
const ADMIN_USERNAME = 'willian2500'; // without @
const VIP_UPI = 'willianxpeed@pingpay';
const VIP_PRICE = '₹99 / Month';
const ADMIN_ID = 6076530076; // <-- apni Telegram numeric ID yahan daalo
const bot = new TelegramBot(TOKEN, { polling: true });
const db = new sqlite3.Database('./bot.db');

// ===== DB INIT =====
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    vip INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    bet INTEGER DEFAULT 1,
    period INTEGER DEFAULT 0,
    mode TEXT DEFAULT 'free',
    history TEXT DEFAULT '[]',
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
});

// ===== HELPERS =====
const nextPeriod = (p) => parseInt(p, 10) + 1;

// Smart trend-based prediction (heuristic)
function smartPredict(history) {
  // history like ['BIG','SMALL','BIG'] (we store BIG/SMALL)
  if (!history || history.length < 2) {
    return Math.random() > 0.5 ? 'BIG' : 'SMALL';
  }
  const last3 = history.slice(-3);
  const bigCount = last3.filter(x => x === 'BIG').length;
  const smallCount = last3.filter(x => x === 'SMALL').length;

  if (bigCount >= 2) return 'SMALL';
  if (smallCount >= 2) return 'BIG';
  return last3[last3.length - 1] === 'BIG' ? 'SMALL' : 'BIG';
}

function resetUser(userId, mode) {
  db.run(
    `INSERT OR REPLACE INTO users (id, vip, level, bet, period, mode, history, updated_at)
     VALUES (?, COALESCE((SELECT vip FROM users WHERE id=?),0), 1, 1, 0, ?, '[]', strftime('%s','now'))`,
    [userId, userId, mode]
  );
}

function ensureUser(userId) {
  db.run(`INSERT OR IGNORE INTO users (id) VALUES (?)`, [userId]);
}

function capHistory(arr, n = 10) {
  if (arr.length > n) return arr.slice(-n);
  return arr;
}

// ===== START =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  ensureUser(userId);

  bot.sendMessage(chatId,
`🎯 *Welcome to Color Trading Bot*

Choose Mode:`,
  {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🆓 Start Free', callback_data: 'start_free' }],
        [{ text: '💎 Buy VIP', callback_data: 'buy_vip' }],
        [{ text: '🧑‍💻 Admin Support', url: `https://t.me/${ADMIN_USERNAME}` }]
      ]
    }
  });
});

// ===== BUTTONS =====
bot.on('callback_query', (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;

  if (q.data === 'start_free') {
    resetUser(userId, 'free');
    bot.sendMessage(chatId, `🆓 *Free Mode Started!*\nSend last 3 digit period number (e.g. 555)`, { parse_mode: 'Markdown' });
  }

  if (q.data === 'buy_vip') {
    bot.sendMessage(chatId,
`💎 *Buy VIP*

Price: ${VIP_PRICE}
UPI: \`${VIP_UPI}\`

After payment, contact admin:
@${ADMIN_USERNAME}`, { parse_mode: 'Markdown' });
  }

  if (q.data === 'result_win' || q.data === 'result_loss') {
    handleResult(q, q.data === 'result_win' ? 'win' : 'loss');
  }
});

// ===== PERIOD INPUT =====
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();

  // Only accept numbers for period step
  if (!/^\d{3,}$/.test(text)) return;

  db.get(`SELECT * FROM users WHERE id=?`, [userId], (err, user) => {
    if (err) return console.error(err);
    if (!user) {
      bot.sendMessage(chatId, `Please type /start first`);
      return;
    }

    const currentPeriod = user.period === 0 ? text : user.period;
    const nextP = nextPeriod(currentPeriod);

    const history = JSON.parse(user.history || '[]'); // BIG/SMALL history
    const prediction = smartPredict(history);

    db.run(`UPDATE users SET period=?, updated_at=strftime('%s','now') WHERE id=?`, [nextP, userId]);

    bot.sendMessage(chatId,
`📊 *Prediction*

Next Period: ${nextP}
Prediction: *${prediction}*
Level: ${user.level}
Bet: ₹${user.bet}

Result select karo 👇`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ WIN', callback_data: 'result_win' }],
            [{ text: '❌ LOSS', callback_data: 'result_loss' }]
          ]
        }
      });
  });
});

// ===== WIN/LOSS HANDLER (Buttons) =====
function handleResult(q, result) {
  const chatId = q.message.chat.id;
  const userId = q.from.id;

  db.get(`SELECT * FROM users WHERE id=?`, [userId], (err, user) => {
    if (err) return console.error(err);
    if (!user) return;

    const maxLevel = user.mode === 'vip' ? 5 : 7;

    let history = JSON.parse(user.history || '[]');
    // Map result to BIG/SMALL trend proxy: WIN -> keep last prediction effect; LOSS -> invert trend proxy
    // Simpler: push BIG for win, SMALL for loss (heuristic)
    history.push(result === 'win' ? 'BIG' : 'SMALL');
    history = capHistory(history, 10);

    if (result === 'win') {
      db.run(`UPDATE users SET level=1, bet=1, history=?, updated_at=strftime('%s','now') WHERE id=?`,
        [JSON.stringify(history), userId]);

      bot.sendMessage(chatId,
        `✅ *WIN!*\nReset to Level 1\n\nSend next period number 👇`,
        { parse_mode: 'Markdown' });

    } else {
      const nextLevel = user.level + 1;
      const nextBet = user.bet * 2;

      if (nextLevel > maxLevel) {
        bot.sendMessage(chatId, `❌ *Max ${maxLevel} Levels Reached.* Session Ended.\nType /start to begin again.`, { parse_mode: 'Markdown' });
        resetUser(userId, user.mode);
      } else {
        db.run(`UPDATE users SET level=?, bet=?, history=?, updated_at=strftime('%s','now') WHERE id=?`,
          [nextLevel, nextBet, JSON.stringify(history), userId]);

        bot.sendMessage(chatId,
`❌ *LOSS*
Next Level: ${nextLevel}
Next Bet: ₹${nextBet}

Send next period number 👇`,
          { parse_mode: 'Markdown' });
      }
    }
  });
}

// ===== ADMIN: ADD VIP =====
bot.onText(/\/addvip (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;

  if (msg.from.id !== ADMIN_ID) {
    bot.sendMessage(chatId, `❌ You are not admin`);
    return;
  }

  const targetId = match[1];
  db.run(`UPDATE users SET vip=1, mode='vip', updated_at=strftime('%s','now') WHERE id=?`, [targetId]);
  bot.sendMessage(chatId, `✅ User ${targetId} is now VIP`);
});
let adminBroadcastMode = false;

bot.onText(/\/broadcast/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, '❌ You are not admin');

  adminBroadcastMode = true;
  bot.sendMessage(msg.chat.id, '📣 Broadcast mode ON.\nAb jo bhi bhejoge (text/photo/video/voice/link/file), sab users ko chala jayega.\nCancel: /cancelbroadcast');
});

bot.onText(/\/cancelbroadcast/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  adminBroadcastMode = false;
  bot.sendMessage(msg.chat.id, '❌ Broadcast mode OFF.');
});

// Catch-all: Admin ka jo bhi message aaye broadcast ho
bot.on('message', (msg) => {
  if (!adminBroadcastMode) return;
  if (msg.from.id !== ADMIN_ID) return;

  db.all(`SELECT id FROM users`, [], (err, rows) => {
    if (err) return console.error(err);

    rows.forEach(u => {
      forwardAny(msg, u.id);
    });
  });
});
let adminSendToUser = null;

bot.onText(/\/send (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, '❌ You are not admin');

  adminSendToUser = match[1];
  bot.sendMessage(msg.chat.id, `🎯 Send mode ON for user ${adminSendToUser}.\nAb jo bhi bhejoge us user ko chala jayega.\nCancel: /cancelsend`);
});

bot.onText(/\/cancelsend/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  adminSendToUser = null;
  bot.sendMessage(msg.chat.id, '❌ Send mode OFF.');
});

// Catch-all: Admin ka jo bhi message aaye selected user ko forward ho
bot.on('message', (msg) => {
  if (!adminSendToUser) return;
  if (msg.from.id !== ADMIN_ID) return;

  forwardAny(msg, adminSendToUser);
});
function forwardAny(msg, targetChatId) {
  try {
    if (msg.text) {
      bot.sendMessage(targetChatId, msg.text, { disable_web_page_preview: false });
    } else if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      bot.sendPhoto(targetChatId, fileId, { caption: msg.caption || '' });
    } else if (msg.video) {
      bot.sendVideo(targetChatId, msg.video.file_id, { caption: msg.caption || '' });
    } else if (msg.voice) {
      bot.sendVoice(targetChatId, msg.voice.file_id);
    } else if (msg.audio) {
      bot.sendAudio(targetChatId, msg.audio.file_id);
    } else if (msg.document) {
      bot.sendDocument(targetChatId, msg.document.file_id, { caption: msg.caption || '' });
    } else if (msg.sticker) {
      bot.sendSticker(targetChatId, msg.sticker.file_id);
    } else {
      // fallback: forward original message
      bot.forwardMessage(targetChatId, msg.chat.id, msg.message_id);
    }
  } catch (e) {
    console.error('Forward failed to', targetChatId, e.message);
  }
}
console.log('🤖 Bot is running...');
