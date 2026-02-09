const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');

// ===== CONFIG =====
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ BOT_TOKEN missing in environment variables');
  process.exit(1);
}
const ADMIN_ID = 6076530076; // <-- apni Telegram numeric ID
const ADMIN_USERNAME = 'willian2500';
const VIP_UPI = 'willianxpeed@pingpay';
const VIP_PRICE = '₹99 / Month';

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
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  // Backfill for old rows
  db.run(`UPDATE users SET created_at = COALESCE(created_at, strftime('%s','now'))`);
});

// ===== HELPERS =====
const nextPeriod = (p) => parseInt(p, 10) + 1;

function smartPredict(history) {
  if (!history || history.length < 2) return Math.random() > 0.5 ? 'BIG' : 'SMALL';
  const last3 = history.slice(-3);
  const bigCount = last3.filter(x => x === 'BIG').length;
  const smallCount = last3.filter(x => x === 'SMALL').length;
  if (bigCount >= 2) return 'SMALL';
  if (smallCount >= 2) return 'BIG';
  return last3[last3.length - 1] === 'BIG' ? 'SMALL' : 'BIG';
}

function resetUser(userId, mode) {
  db.run(
    `INSERT OR REPLACE INTO users (id, vip, level, bet, period, mode, history, created_at, updated_at)
     VALUES (?, COALESCE((SELECT vip FROM users WHERE id=?),0), 1, 1, 0, ?, '[]',
             COALESCE((SELECT created_at FROM users WHERE id=?), strftime('%s','now')),
             strftime('%s','now'))`,
    [userId, userId, mode, userId]
  );
}

function ensureUser(userId) {
  db.run(
    `INSERT OR IGNORE INTO users (id, created_at, updated_at) VALUES (?, strftime('%s','now'), strftime('%s','now'))`,
    [userId]
  );
}

function capHistory(arr, n = 10) {
  return arr.length > n ? arr.slice(-n) : arr;
}

// ===== START =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  ensureUser(userId);

  db.get(`SELECT vip FROM users WHERE id=?`, [userId], (err, row) => {
    const isVip = row && row.vip === 1;

    const buttons = [
      [{ text: '🆓 Start Free', callback_data: 'start_free' }],
      isVip ? [{ text: '💎 Start VIP', callback_data: 'start_vip' }] : [{ text: '💎 Buy VIP', callback_data: 'buy_vip' }],
      [{ text: '🧑‍💻 Admin Support', url: `https://t.me/${ADMIN_USERNAME}` }]
    ];

    bot.sendMessage(chatId,
`🎯 *Welcome to Color Trading Bot*

Choose Mode:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  });
});

// ===== CALLBACKS =====
bot.on('callback_query', (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;

  if (q.data === 'start_free') {
    resetUser(userId, 'free');
    return bot.sendMessage(chatId, `🆓 *Free Mode Started!*\nSend last 3 digit period number (e.g. 555)`, { parse_mode: 'Markdown' });
  }

  if (q.data === 'start_vip') {
    return db.get(`SELECT vip FROM users WHERE id=?`, [userId], (err, row) => {
      if (!row || row.vip !== 1) return bot.sendMessage(chatId, '❌ VIP access nahi hai. Buy VIP first.');
      resetUser(userId, 'vip');
      bot.sendMessage(chatId,
`💎 *VIP Mode Activated!*
Rules:
• Levels: 1 to 5  
• Loss pe ×2  
• Win pe reset

Send last 3 digit period number (e.g. 555) 👇`,
        { parse_mode: 'Markdown' }
      );
    });
  }

  if (q.data === 'buy_vip') {
    return bot.sendMessage(chatId,
`💎 *Buy VIP*
Price: ${VIP_PRICE}
UPI: \`${VIP_UPI}\`

After payment, contact admin:
@${ADMIN_USERNAME}`, { parse_mode: 'Markdown' });
  }

  if (q.data === 'result_win' || q.data === 'result_loss') {
    return handleResult(q, q.data === 'result_win' ? 'win' : 'loss');
  }
});

// ===== ADMIN TOOLS =====
let adminBroadcastMode = false;
let adminSendToUser = null;

bot.onText(/\/addvip (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, '❌ You are not admin');
  const targetId = match[1];
  db.run(`UPDATE users SET vip=1, mode='vip', updated_at=strftime('%s','now') WHERE id=?`, [targetId]);
  bot.sendMessage(msg.chat.id, `✅ User ${targetId} is now VIP`);
});

bot.onText(/\/broadcast/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, '❌ You are not admin');
  adminBroadcastMode = true;
  bot.sendMessage(msg.chat.id, '📣 Broadcast mode ON. Ab jo bhi bhejoge sab users ko jayega.\nCancel: /cancelbroadcast');
});

bot.onText(/\/cancelbroadcast/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  adminBroadcastMode = false;
  bot.sendMessage(msg.chat.id, '❌ Broadcast mode OFF.');
});

bot.onText(/\/send (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, '❌ You are not admin');
  adminSendToUser = match[1];
  bot.sendMessage(msg.chat.id, `🎯 Send mode ON for user ${adminSendToUser}.\nCancel: /cancelsend`);
});

bot.onText(/\/cancelsend/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  adminSendToUser = null;
  bot.sendMessage(msg.chat.id, '❌ Send mode OFF.');
});

// ===== STATS =====
bot.onText(/\/stats/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, '❌ You are not admin');

  const now = Math.floor(Date.now() / 1000);
  const last24h = now - 24 * 60 * 60;
  const monthStart = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);

  db.serialize(() => {
    db.get(`SELECT COUNT(*) AS total FROM users`, (_, t) => {
      db.get(`SELECT COUNT(*) AS active FROM users WHERE updated_at >= ?`, [last24h], (_, a) => {
        db.get(`SELECT COUNT(*) AS vip FROM users WHERE vip=1`, (_, v) => {
          db.get(`SELECT COUNT(*) AS vipMonth FROM users WHERE vip=1 AND updated_at >= ?`, [monthStart], (_, vm) => {
            db.get(`SELECT COUNT(*) AS new24h FROM users WHERE created_at >= ?`, [last24h], (_, n) => {
              bot.sendMessage(msg.chat.id,
`📊 *Bot Stats*
👥 Total Users: *${t.total}*
⚡ Active (24h): *${a.active}*
💎 VIP Users: *${v.vip}*
🆕 VIP This Month: *${vm.vipMonth}*
📈 New Users (24h): *${n.new24h}*`,
                { parse_mode: 'Markdown' }
              );
            });
          });
        });
      });
    });
  });
});

// ===== PERIOD INPUT (with admin mode guard) =====
bot.on('message', (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Admin broadcast/send modes
  if ((adminBroadcastMode || adminSendToUser) && msg.from.id === ADMIN_ID) {
    db.all(`SELECT id FROM users`, [], (err, rows) => {
      if (adminBroadcastMode) rows.forEach(u => forwardAny(msg, u.id));
      if (adminSendToUser) forwardAny(msg, adminSendToUser);
    });
    return;
  }

  if (!/^\d{3,}$/.test(text)) return;

  db.get(`SELECT * FROM users WHERE id=?`, [userId], (err, user) => {
    if (err || !user) return;
    const currentPeriod = user.period === 0 ? text : user.period;
    const nextP = nextPeriod(currentPeriod);
    const history = JSON.parse(user.history || '[]');
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
      }
    );
  });
});

// ===== RESULT HANDLER =====
function handleResult(q, result) {
  const userId = q.from.id;
  const chatId = q.message.chat.id;

  db.get(`SELECT * FROM users WHERE id=?`, [userId], (err, user) => {
    if (err || !user) return;
    const maxLevel = user.mode === 'vip' ? 5 : 7;

    let history = capHistory(JSON.parse(user.history || '[]').concat(result === 'win' ? 'BIG' : 'SMALL'));

    if (result === 'win') {
      db.run(`UPDATE users SET level=1, bet=1, history=?, updated_at=strftime('%s','now') WHERE id=?`, [JSON.stringify(history), userId]);
      return bot.sendMessage(chatId, `✅ *WIN!*\nReset to Level 1\nSend next period number 👇`, { parse_mode: 'Markdown' });
    }

    const nextLevel = user.level + 1;
    const nextBet = user.bet * 2;
    if (nextLevel > maxLevel) {
      resetUser(userId, user.mode);
      return bot.sendMessage(chatId, `❌ *Max ${maxLevel} Levels Reached.* Session Ended.\nType /start to begin again.`, { parse_mode: 'Markdown' });
    }

    db.run(`UPDATE users SET level=?, bet=?, history=?, updated_at=strftime('%s','now') WHERE id=?`,
      [nextLevel, nextBet, JSON.stringify(history), userId]);

    bot.sendMessage(chatId,
`❌ *LOSS*
Next Level: ${nextLevel}
Next Bet: ₹${nextBet}
Send next period number 👇`,
      { parse_mode: 'Markdown' }
    );
  });
}

// ===== FORWARD HELPER =====
function forwardAny(msg, targetChatId) {
  try {
    if (msg.text) return bot.sendMessage(targetChatId, msg.text, { disable_web_page_preview: false });
    if (msg.photo) return bot.sendPhoto(targetChatId, msg.photo.at(-1).file_id, { caption: msg.caption || '' });
    if (msg.video) return bot.sendVideo(targetChatId, msg.video.file_id, { caption: msg.caption || '' });
    if (msg.voice) return bot.sendVoice(targetChatId, msg.voice.file_id);
    if (msg.audio) return bot.sendAudio(targetChatId, msg.audio.file_id);
    if (msg.document) return bot.sendDocument(targetChatId, msg.document.file_id, { caption: msg.caption || '' });
    if (msg.sticker) return bot.sendSticker(targetChatId, msg.sticker.file_id);
    return bot.forwardMessage(targetChatId, msg.chat.id, msg.message_id);
  } catch (e) {
    console.error('Forward failed:', e.message);
  }
}

// ===== DUMMY WEB SERVER (Render Web Service) =====
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(PORT, () => console.log(`🌐 Web server listening on ${PORT}`));

console.log('🤖 Bot is running...');
