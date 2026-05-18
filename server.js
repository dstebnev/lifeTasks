'use strict';

require('dotenv').config();
const express = require('express');
const cron    = require('node-cron');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const PORT         = parseInt(process.env.PORT || '3000', 10);
const TZ           = process.env.TZ || 'Europe/Moscow';
const REPORT_TOKEN = process.env.REPORT_TOKEN || '';

// /data is Amvera's persistenceMount — survives redeploys.
// Locally falls back to project directory.
const DATA_DIR  = fs.existsSync('/data') ? '/data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (!BOT_TOKEN) {
  console.error('❌  BOT_TOKEN is not set. Copy .env.example → .env and fill it in.');
  process.exit(1);
}

/* ── Telegram initData validation ─────────────────────────────────────────
   Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
   Returns parsed user object or null if signature is invalid.
────────────────────────────────────────────────────────────────────────── */
function validateInitData(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get('hash');
    if (!receivedHash) return null;

    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (expectedHash !== receivedHash) return null;

    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch {
    return null;
  }
}

/* ── Auth middleware — extracts userId from verified Telegram initData ── */
function auth(req, res, next) {
  const initData = req.headers['x-init-data'];
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = String(user.id);
  req.chatId = user.id;
  next();
}

/* ── Data helpers ── */
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return {}; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* ── Express ── */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

/* GET /api/quests — load quests for authenticated user */
app.get('/api/quests', auth, (req, res) => {
  const data = loadData();
  const record = data[req.userId];
  // found:false → пользователь ещё не сохранял данные → клиент оставит localStorage
  // found:true  → данные на сервере авторитетны (даже если quests: [])
  res.json(record
    ? { found: true,  quests: record.quests }
    : { found: false, quests: [] });
});

/* POST /api/quests — save quests for authenticated user */
app.post('/api/quests', auth, (req, res) => {
  const { quests } = req.body;
  if (!Array.isArray(quests)) return res.status(400).json({ error: 'quests must be array' });

  const data = loadData();
  data[req.userId] = {
    quests,
    chatId: req.chatId,
    updatedAt: new Date().toISOString(),
  };
  saveData(data);
  res.json({ ok: true });
});

/* POST /api/report/test — manually trigger report for the authenticated user.
   Requires REPORT_TOKEN header matching the env variable (if configured). */
app.post('/api/report/test', auth, async (req, res) => {
  if (REPORT_TOKEN && req.headers['x-report-token'] !== REPORT_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const data = loadData();
  const record = data[req.userId];
  if (!record) return res.status(404).json({ error: 'user not found' });
  try {
    await sendReportToUser(record);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Telegram Bot API ── */
async function telegramPost(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/* ── Report builder ── */
function formatNum(n) {
  return Number(n).toLocaleString('ru-RU');
}

function progressPercent(p) {
  if (!p) return null;
  if (p.type === 'percent') return Math.min(100, Math.max(0, p.value));
  if (p.type === 'numeric' && p.target > 0)
    return Math.min(100, Math.max(0, Math.round((p.current / p.target) * 100)));
  return null;
}

function progressLabel(p) {
  if (!p) return null;
  if (p.type === 'percent') return `${p.value}%`;
  if (p.type === 'numeric') {
    const u = p.unit ? ` ${p.unit}` : '';
    return `${formatNum(p.current)}${u} / ${formatNum(p.target)}${u}`;
  }
  return null;
}

function deadlineLabel(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00');
  const today  = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((target - today) / 86400000);
  const fmt  = target.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  if (diff < 0)   return `⛔ Просрочен: ${fmt}`;
  if (diff === 0) return `🔥 Сегодня!`;
  if (diff <= 7)  return `⚠️ ${fmt} (через ${diff} дн.)`;
  return `📅 ${fmt}`;
}

function progressBar(pct) {
  const filled = Math.round(pct / 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
}

function questBlock(q, index, icon) {
  const lines = [`${icon} <b>${index}. ${q.title}</b>`];

  if (q.nextGoal)  lines.push(`   ⚡ <i>${q.nextGoal}</i>`);

  const pct = progressPercent(q.progress);
  const lbl = progressLabel(q.progress);
  if (pct !== null) {
    lines.push(`   ${progressBar(pct)}`);
    if (lbl) lines.push(`   ${lbl}`);
  }

  const dl = deadlineLabel(q.deadline);
  if (dl) lines.push(`   ${dl}`);

  const activeSubs = q.subQuests?.filter(s => s.nextGoal || progressPercent(s.progress) !== null);
  if (activeSubs?.length) {
    lines.push(`   📋 Вложенные:`);
    activeSubs.slice(0, 3).forEach(s => {
      const sp = progressPercent(s.progress);
      lines.push(`     • ${s.title}${sp !== null ? ` — ${sp}%` : ''}`);
      if (s.nextGoal) lines.push(`       ⚡ <i>${s.nextGoal}</i>`);
    });
  }

  return lines.join('\n');
}

function buildReportText(quests) {
  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const mainQ   = quests.filter(q => q.type === 'main');
  const activeSide = quests.filter(q => q.type === 'side' && q.active);

  const sections = [];
  sections.push(`🗓 <b>Воскресный отчёт по квестам</b>\n${today}\n`);

  if (mainQ.length) {
    sections.push(`⚔️ <b>ГЛАВНЫЕ КВЕСТЫ</b> (${mainQ.length})`);
    mainQ.forEach((q, i) => sections.push(questBlock(q, i + 1, '🗡')));
  }

  if (activeSide.length) {
    sections.push(`\n📜 <b>АКТИВНЫЕ ДОП. КВЕСТЫ</b> (${activeSide.length})`);
    activeSide.forEach((q, i) => sections.push(questBlock(q, i + 1, '📌')));
  }

  if (!mainQ.length && !activeSide.length) {
    sections.push('У вас пока нет активных квестов. Откройте LifeQuest и начните своё приключение! ⚔️');
    return sections.join('\n');
  }

  sections.push(`\n💡 <i>Сосредоточьтесь на ближайших целях — сделайте хотя бы один шаг по каждому активному квесту!</i>`);
  return sections.join('\n');
}

/* ── Send report to one user ── */
async function sendReportToUser(record) {
  const text = buildReportText(record.quests || []);
  const result = await telegramPost('sendMessage', {
    chat_id:    record.chatId,
    text,
    parse_mode: 'HTML',
  });
  if (!result.ok) throw new Error(result.description);
  return result;
}

/* ── Sunday cron ── */
// Runs every Sunday at 10:00 in the configured timezone
cron.schedule('0 10 * * 0', async () => {
  console.log(`[${new Date().toISOString()}] Running Sunday report...`);
  const data = loadData();
  const users = Object.entries(data);

  let ok = 0, fail = 0;
  for (const [userId, record] of users) {
    try {
      await sendReportToUser(record);
      ok++;
      console.log(`  ✓ Sent to user ${userId}`);
    } catch (e) {
      fail++;
      console.error(`  ✗ Failed for user ${userId}: ${e.message}`);
    }
  }
  console.log(`Done: ${ok} sent, ${fail} failed.`);
}, { timezone: TZ });

/* ── Health check (Amvera проверяет /healthz или корень) ── */
app.get('/healthz', (_, res) => res.json({ ok: true }));

/* ── Start ── */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🗡  LifeQuest server on 0.0.0.0:${PORT}  data=${DATA_FILE}`);
  console.log(`📅  Weekly report: Sunday 10:00 (${TZ})`);
});
