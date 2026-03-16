import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import TelegramBot from 'node-telegram-bot-api';
import db from './db.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const JWT_SECRET = 'swiftly-secret-key';
const clients = new Map();

// Telegram bot for sending codes
const tgBot = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })
  : null;

// Map username -> chat_id (filled when user starts the bot)
const tgUsers = new Map();

if (tgBot) {
  tgBot.on('message', (msg) => {
    const username = msg.from?.username;
    if (username) {
      tgUsers.set(username.toLowerCase(), msg.chat.id);
      console.log(`TG: registered @${username} -> ${msg.chat.id}`);
    }
  });
}

async function sendTelegramCode(username, code) {
  if (!tgBot) {
    console.log(`\n📱 [DEV] Code for @${username}: ${code}\n`);
    return;
  }
  const chatId = tgUsers.get(username.toLowerCase());
  if (!chatId) throw new Error('User not found. Ask user to start the bot first.');
  await tgBot.sendMessage(chatId, `🔐 Ваш код Swiftly: *${code}*\n\nНе сообщайте его никому.`, { parse_mode: 'Markdown' });
}

app.use(cors());
app.use(express.json());

// --- Auth middleware ---
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Auth routes ---

// Step 1: send code via Telegram
app.post('/api/auth/send-code', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Telegram username required' });
  const normalized = username.replace('@', '').toLowerCase().trim();
  if (!/^[a-z0-9_]{3,32}$/.test(normalized)) return res.status(400).json({ error: 'Invalid username' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires_at = Math.floor(Date.now() / 1000) + 300;

  db.prepare('INSERT OR REPLACE INTO phone_codes (phone, code, expires_at) VALUES (?, ?, ?)').run(normalized, code, expires_at);

  try {
    await sendTelegramCode(normalized, code);
    res.json({ ok: true });
  } catch (err) {
    console.error('TG error:', err.message);
    res.status(500).json({ error: `Не удалось отправить код. Убедитесь что вы написали боту /start` });
  }
});

// Step 2: verify code
app.post('/api/auth/verify-code', (req, res) => {
  const { username, code } = req.body;
  console.log('verify-code request:', { username, code });
  if (!username || !code) return res.status(400).json({ error: 'Username and code required' });
  const normalized = username.replace('@', '').toLowerCase().trim();

  const row = db.prepare('SELECT * FROM phone_codes WHERE phone = ?').get(normalized);
  console.log('DB row:', normalized, row);
  if (!row) return res.status(400).json({ error: 'Code not found' });
  if (Math.floor(Date.now() / 1000) > row.expires_at) return res.status(400).json({ error: 'Code expired' });
  if (row.code !== code) return res.status(400).json({ error: 'Wrong code' });

  db.prepare('DELETE FROM phone_codes WHERE phone = ?').run(normalized);

  const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(normalized);
  if (existing) {
    const token = jwt.sign({ id: existing.id, username: existing.username }, JWT_SECRET);
    return res.json({ token, user: { id: existing.id, username: existing.username }, isNew: false });
  }
  res.json({ isNew: true, tgUsername: normalized });
});

// Step 3: set display name for new users
app.post('/api/auth/set-username', (req, res) => {
  const { tgUsername, username } = req.body;
  if (!tgUsername || !username) return res.status(400).json({ error: 'Required fields missing' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username taken' });
  const id = uuidv4();
  const hash = bcrypt.hashSync(tgUsername + '_tg_auth', 10);
  db.prepare('INSERT INTO users (id, username, phone, password) VALUES (?, ?, ?, ?)').run(id, username, tgUsername, hash);
  const token = jwt.sign({ id, username }, JWT_SECRET);
  res.json({ token, user: { id, username } });
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Required fields missing' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username taken' });
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)').run(id, username, hash);
  const token = jwt.sign({ id, username }, JWT_SECRET);
  res.json({ token, user: { id, username } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
  res.json({ token, user: { id: user.id, username: user.username } });
});

// --- Profile ---
app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, bio FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

app.put('/api/me', auth, (req, res) => {
  const { username, bio } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
  if (taken) return res.status(409).json({ error: 'Username taken' });
  db.prepare('UPDATE users SET username = ?, bio = ? WHERE id = ?').run(username, bio || '', req.user.id);
  const token = jwt.sign({ id: req.user.id, username }, JWT_SECRET);
  res.json({ token, user: { id: req.user.id, username, bio } });
});

// --- Users ---
app.get('/api/users', auth, (req, res) => {
  const users = db.prepare('SELECT id, username FROM users WHERE id != ?').all(req.user.id);
  res.json(users);
});

// --- Chats ---
app.get('/api/chats', auth, (req, res) => {
  const chats = db.prepare(`
    SELECT c.id, c.name, c.is_group,
      (SELECT text FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_at
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY last_at DESC
  `).all(req.user.id);

  // For DMs, get the other user's name
  const result = chats.map(chat => {
    if (!chat.is_group) {
      const other = db.prepare(`
        SELECT u.id, u.username FROM users u
        JOIN chat_members cm ON cm.user_id = u.id
        WHERE cm.chat_id = ? AND u.id != ?
      `).get(chat.id, req.user.id);
      return { ...chat, name: other?.username, other_user_id: other?.id };
    }
    return chat;
  });

  res.json(result);
});

app.post('/api/chats/dm', auth, (req, res) => {
  const { userId } = req.body;
  // Check if DM already exists
  const existing = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = ?
    JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = ?
    WHERE c.is_group = 0
  `).get(req.user.id, userId);

  if (existing) return res.json({ id: existing.id });

  const id = uuidv4();
  db.prepare('INSERT INTO chats (id, is_group) VALUES (?, 0)').run(id);
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(id, userId);
  res.json({ id });
});

// --- Messages ---
app.get('/api/chats/:chatId/messages', auth, (req, res) => {
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(req.params.chatId, req.user.id);
  if (!member) return res.status(403).json({ error: 'Forbidden' });

  const messages = db.prepare(`
    SELECT m.id, m.text, m.created_at, m.sender_id, u.username as sender_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ?
    ORDER BY m.created_at ASC
  `).all(req.params.chatId);
  res.json(messages);
});

// --- WebSocket ---
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'auth') {
        try {
          const user = jwt.verify(msg.token, JWT_SECRET);
          ws.userId = user.id;
          clients.set(user.id, ws);
        } catch {
          ws.close();
        }
        return;
      }

      if (msg.type === 'message' && ws.userId) {
        const { chatId, text } = msg;
        const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
          .get(chatId, ws.userId);
        if (!member) return;

        const id = uuidv4();
        const created_at = Math.floor(Date.now() / 1000);
        const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(ws.userId);

        db.prepare('INSERT INTO messages (id, chat_id, sender_id, text, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, chatId, ws.userId, text, created_at);

        const payload = JSON.stringify({
          type: 'message',
          message: { id, chat_id: chatId, sender_id: ws.userId, sender_name: sender.username, text, created_at }
        });

        // Send to all members of the chat
        const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
        members.forEach(({ user_id }) => {
          const client = clients.get(user_id);
          if (client?.readyState === 1) client.send(payload);
        });
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on('close', () => {
    if (ws.userId) clients.delete(ws.userId);
  });
});

server.listen(3001, () => console.log('Server running on http://localhost:3001'));
