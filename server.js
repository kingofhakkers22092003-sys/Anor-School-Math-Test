require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');
const OpenAI = require('openai');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.warn('DIQQAT: .env faylida OPENAI_API_KEY topilmadi. AI baholash ishlamaydi (talabalar javobi "o\'qituvchi tekshiradi" holatida qoladi).');
}

// API kaliti bo'lmasa ham qolgan funksiyalar (ro'yxatdan o'tish, savollar,
// ustoz tekshiruvi va Telegram) ishlashi kerak. AI baholash so'rovlari esa
// mavjud catch blokiga tushib, ustoz tekshiruviga qaytadi.
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Amaliy yechimlar JSON orqali yuborilgani uchun limit kattaroq qilindi.
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname)));

const uploadDir = path.join(__dirname, 'tmp_uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir, limits: { fileSize: 20 * 1024 * 1024 } });

// ================= UMUMIY MA'LUMOTLAR BAZASI (barcha kompyuterlar uchun) =================
// Bu bo'lim barcha ulangan qurilmalarning bir xil ma'lumotni (o'quvchilar, savollar,
// baholash rejimi) ko'rishi uchun kerak. Ma'lumotlar shu papkadagi data/store.json
// faylida saqlanadi (localStorage o'rniga), shuning uchun qaysi kompyuterdan kirilmasin
// natijalar bitta joyda jamlanadi.

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
// Ma'lumotlar endi uch alohida faylda saqlanadi, shunda har birini alohida
// ko'rish/zaxira olish oson bo'ladi:
//  - students.json   -> o'quvchilarning ro'yxatdan o'tgan ma'lumotlari va natijalari
//  - questions.json  -> savollar banki (barcha bo'limlar uchun)
//  - settings.json   -> umumiy sozlamalar (masalan, baholash rejimi)
const STUDENTS_FILE = path.join(dataDir, 'students.json');
const QUESTIONS_FILE = path.join(dataDir, 'questions.json');
const SETTINGS_FILE = path.join(dataDir, 'settings.json');
const LEGACY_DB_FILE = path.join(dataDir, 'store.json'); // eski (bitta fayl) format - faqat bir martalik migratsiya uchun

const TEST_KEYS = ['Test', 'Amaliy'];

const DEFAULT_QUESTIONS = {
  Test: [
    { id: 't1', prompt: '15 + 27 = ?', options: ['32', '42', '52', '41'], answer: '1' },
    { id: 't2', prompt: '8 × 7 = ?', options: ['54', '56', '48', '63'], answer: '1' },
    { id: 't3', prompt: '3² + 4² = ?', options: ['7', '12', '25', '49'], answer: '2' },
    { id: 't4', prompt: 'Agar 2x = 18 bo‘lsa, x ning qiymati qancha?', options: ['8', '9', '16', '36'], answer: '1' },
    { id: 't5', prompt: '1/2 + 1/4 = ?', options: ['1/6', '2/6', '3/4', '1/4'], answer: '2' },
  ],
  Amaliy: [
    { id: 'p1', prompt: '5 ta daftar 12 000 so‘m. 3 ta daftar necha so‘m turadi? Yechimini qadam-baqadam yozing.' },
    { id: 'p2', prompt: 'To‘g‘ri to‘rtburchakning tomonlari 8 sm va 5 sm. Yuzasi va perimetrini toping.' },
    { id: 'p3', prompt: '3(x + 4) = 21 tenglamasini yeching. Yechimni qadam-baqadam yozing.' },
  ],
};

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadDb() {
  let students = readJsonFile(STUDENTS_FILE);
  let questionBank = readJsonFile(QUESTIONS_FILE);
  let settings = readJsonFile(SETTINGS_FILE);

  // Eski bitta-fayllik (data/store.json) formatdan bir martalik migratsiya:
  // agar yangi fayllar hali mavjud bo'lmasa va eski fayl bo'lsa, undan o'qib olamiz.
  if ((!students || !questionBank || !settings) && fs.existsSync(LEGACY_DB_FILE)) {
    const legacy = readJsonFile(LEGACY_DB_FILE) || {};
    if (!students) students = legacy.students || [];
    if (!questionBank) questionBank = legacy.questionBank || null;
    if (!settings) settings = { gradingMode: legacy.gradingMode || 'teacher' };
  }

  if (!students) students = [];
  if (!questionBank) questionBank = JSON.parse(JSON.stringify(DEFAULT_QUESTIONS));
  if (!settings) settings = { gradingMode: 'teacher' };

  // Eski o'quvchi yozuvlarida yangi maydonlar bo'lmasligi mumkin - xavfsiz standart qiymat beramiz.
  students.forEach(student => {
    if (typeof student.telegramSent !== 'boolean') student.telegramSent = false;
    if (student.telegramError === undefined) student.telegramError = null;
    student.pendingReview = student.pendingReview || {};
    student.attempts = student.attempts || [];
    student.results = student.results || {};
  });

  // Admin login va parol endi fayl orqali saqlanadi (standart: admin / admin), shunda
  // o'qituvchi buni dashboarddan o'zgartirishi mumkin bo'ladi.
  const db = {
    students,
    questionBank,
    gradingMode: settings.gradingMode || 'teacher',
    adminUsername: settings.adminUsername || 'admin',
    adminPassword: settings.adminPassword || 'admin',
  };
  saveDb(db); // fayllar hali mavjud bo'lmasa (yoki migratsiyadan keyin) darhol yozib qo'yamiz
  return db;
}
function saveDb(db) {
  fs.writeFileSync(STUDENTS_FILE, JSON.stringify(db.students, null, 2));
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(db.questionBank, null, 2));
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ gradingMode: db.gradingMode, adminUsername: db.adminUsername, adminPassword: db.adminPassword }, null, 2));
}

// Bir vaqtda bir nechta kompyuterdan so'rov kelganda faylga yozish ustma-ust
// tushib ketmasligi uchun barcha o'zgartirishlar shu navbat orqali ketma-ket bajariladi.
let dbQueue = Promise.resolve();
function withDb(fn) {
  const run = dbQueue.then(() => {
    const db = loadDb();
    return fn(db);
  });
  dbQueue = run.then(() => {}, () => {});
  return run;
}

function sanitizeStudent(student) {
  if (!student) return student;
  const { password, ...rest } = student;
  return rest;
}

function maybeArchiveAttempt(student) {
  const allDone = TEST_KEYS.every(key => student.results[key] && !student.results[key].pending);
  if (!allDone) return student;
  const completedAt = student.results.Amaliy?.completedAt || new Date().toISOString();
  student.attempts = student.attempts || [];
  if (student.attempts.some(attempt => attempt.id === completedAt)) return student;
  const snapshot = JSON.parse(JSON.stringify(student.results));
  student.attempts = [...student.attempts, { id: completedAt, completedAt, results: snapshot }].slice(-5);
  return student;
}

function findStudent(db, id) {
  return db.students.find(item => item.id === id);
}

function isFullyGraded(student) {
  return TEST_KEYS.every(key => student.results && student.results[key] && !student.results[key].pending);
}

// ---------- Natija PDF'ini serverda tayyorlash (Telegramga avtomatik yuborish uchun) ----------
// Bu funksiya brauzerdagi makePdf() bilan bir xil ishlaydi, faqat natija Blob emas, Buffer bo'ladi.
function pdfSafe(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019]/g, "'").replace(/[^\x20-\x7E]/g, '?').replace(/[\\()]/g, '\\$&');
}
function buildResultPdfBuffer(student) {
  const results = TEST_KEYS.map(key => student.results[key]);
  const labels = TEST_KEYS;
  const stream = [
    'q', '0.93 0.95 0.97 rg', '0 0 595 842 re f',
    '0.06 0.16 0.26 rg', '0 670 595 172 re f',
    '0.10 0.65 0.63 rg', '0 670 595 6 re f',
    'BT', '/F2 27 Tf', '1 1 1 rg', '57 774 Td', '(ANOR SCHOOL) Tj',
    '/F1 11 Tf', '0 -23 Td', '0.49 0.88 0.85 rg', '(MATHEMATICS DIAGNOSTIC REPORT) Tj',
    '/F1 10 Tf', '0 -48 Td', '1 1 1 rg', `(Student: ${pdfSafe(student.fullName)}) Tj`,
    '0 -17 Td', `(Class: ${pdfSafe(student.schoolClass)}) Tj`,
    '255 17 Td', `(Date: ${new Date().toLocaleDateString('en-CA')}) Tj`, 'ET',
    '0.06 0.16 0.26 rg', 'BT', '/F2 18 Tf', '57 625 Td', '(Assessment summary) Tj',
    '/F1 10 Tf', '0 -18 Td', '0.35 0.40 0.42 rg', '(Results from the completed mathematics diagnostic.) Tj', 'ET',
    '0.06 0.16 0.26 rg', '57 556 481 34 re f',
    'BT', '/F2 10 Tf', '1 1 1 rg', '73 569 Td', '(SECTION) Tj', '315 0 Td', '(RESULT) Tj', 'ET'
  ];
  results.forEach((result, index) => {
    const y = 512 - index * 48; const fill = index % 2 === 0 ? '0.89 0.94 0.98' : '0.93 0.95 0.97';
    const score = result && result.pending ? 'Teacher review pending' : `${result.score} / ${result.total}`;
    stream.push(fill + ' rg', `57 ${y} 481 47 re f`, '0.10 0.65 0.63 rg', `57 ${y} 5 47 re f`,
      '0.06 0.16 0.26 rg', 'BT', '/F2 12 Tf', `75 ${y + 19} Td`, `(${pdfSafe(labels[index])}) Tj`, '/F1 9 Tf', '0 -13 Td', `(Mathematics section ${index + 1}) Tj`, 'ET',
      '0.06 0.16 0.26 rg', 'BT', '/F2 12 Tf', `378 ${y + 18} Td`, `(${pdfSafe(score)}) Tj`, 'ET');
  });
  stream.push('0.10 0.65 0.63 rg', '57 400 481 1 re f',
    '0.06 0.16 0.26 rg', 'BT', '/F2 11 Tf', '57 370 Td', '(Teacher review) Tj',
    '/F1 9 Tf', '0 -15 Td', '0.35 0.40 0.42 rg', '(Practical task scores are confirmed after teacher or AI review.) Tj',
    '0.06 0.16 0.26 rg', '0 -105 Td', '(ANOR INTERNATIONAL SCHOOL) Tj',
    '0.35 0.40 0.42 rg', '0 -14 Td', '(Mathematics Programme - Student Assessment Report) Tj', 'ET', 'Q');
  const content = stream.join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }); const xref = pdf.length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

async function sendTelegramDocument(buffer, filename, caption) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    throw new Error('Telegram sozlanmagan (.env faylida TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID yo\u2018q).');
  }
  const form = new FormData();
  form.append('chat_id', process.env.TELEGRAM_CHAT_ID);
  if (caption) form.append('caption', caption);
  form.append('document', buffer, { filename, contentType: 'application/pdf' });
  const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`;
  const response = await fetch(telegramUrl, { method: 'POST', body: form });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || 'Telegram xatosi.');
}

// Barcha 5 bo'lim ustoz/AI tomonidan tasdiqlangach, natija PDF avtomatik ravishda
// Telegram guruhga yuboriladi. Muvaffaqiyatli yuborilgach `telegramSent` true bo'ladi,
// va faqat shundan keyin o'quvchi profilidagi natijalar oynasini yopish (reset) mumkin bo'ladi.
// Agar yuborishda xatolik bo'lsa (masalan internet yo'q), keyingi safar shu o'quvchining
// ma'lumoti so'ralganda (dashboard yangilanganda) avtomatik qayta urinib ko'riladi.
async function finalizeIfComplete(student) {
  if (!isFullyGraded(student)) return;
  if (student.telegramSent) return;
  try {
    const buffer = buildResultPdfBuffer(student);
    const filename = `Anor-School-matematika-${student.fullName.replace(/[^a-z0-9]+/gi, '-')}.pdf`;
    const caption = `${student.fullName} \u2014 ${student.schoolClass} sinf\nMatematika diagnostikasi natijasi`;
    await sendTelegramDocument(buffer, filename, caption);
    student.telegramSent = true;
    student.telegramError = null;
  } catch (err) {
    student.telegramSent = false;
    student.telegramError = err.message || 'Telegramga yuborishda xatolik.';
  }
}

// ---------- O'quvchilar: ro'yxatdan o'tish / kirish / ro'yxat ----------
app.get('/api/students', (req, res) => {
  withDb(db => db.students.map(sanitizeStudent))
    .then(list => res.json(list))
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.get('/api/students/:id', (req, res) => {
  withDb(async db => {
    const student = findStudent(db, req.params.id);
    if (!student) return null;
    maybeArchiveAttempt(student);
    await finalizeIfComplete(student);
    saveDb(db);
    return sanitizeStudent(student);
  })
    .then(student => {
      if (!student) return res.status(404).json({ error: 'not-found' });
      res.json(student);
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/register', (req, res) => {
  const { fullName, schoolClass, password } = req.body || {};
  if (!fullName || !schoolClass || !password) return res.status(400).json({ error: 'invalid' });
  withDb(db => {
    if (fullName.trim().toLowerCase() === db.adminUsername.toLowerCase()) return { error: 'admin-reserved' };
    const exists = db.students.some(item => item.fullName.toLowerCase() === fullName.trim().toLowerCase() && item.schoolClass === schoolClass);
    if (exists) return { error: 'duplicate' };
    const student = {
      id: crypto.randomUUID(),
      fullName: fullName.trim(),
      schoolClass,
      password,
      results: {},
      attempts: [],
      pendingReview: {},
      telegramSent: false,
      telegramError: null,
    };
    db.students.push(student);
    saveDb(db);
    return { student: sanitizeStudent(student) };
  })
    .then(result => {
      if (result.error === 'admin-reserved') return res.status(400).json({ error: 'admin-reserved' });
      if (result.error === 'duplicate') return res.status(409).json({ error: 'duplicate' });
      res.json(result.student);
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/login', (req, res) => {
  const { fullName, password } = req.body || {};
  if (!fullName || !password) return res.status(400).json({ error: 'invalid' });
  withDb(db => db.students.find(item => item.fullName.toLowerCase() === fullName.trim().toLowerCase() && item.password === password))
    .then(student => {
      if (!student) return res.status(401).json({ error: 'invalid-credentials' });
      res.json(sanitizeStudent(student));
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/students/:id/result', (req, res) => {
  const { section, score, total, note } = req.body || {};
  if (!section) return res.status(400).json({ error: 'invalid' });
  withDb(async db => {
    const student = findStudent(db, req.params.id);
    if (!student) return null;
    student.results = { ...(student.results || {}), [section]: { score, total, note: note || '', pending: false, completedAt: new Date().toISOString() } };
    if (student.pendingReview?.[section]) { const rest = { ...student.pendingReview }; delete rest[section]; student.pendingReview = rest; }
    maybeArchiveAttempt(student);
    await finalizeIfComplete(student);
    saveDb(db);
    return sanitizeStudent(student);
  })
    .then(student => {
      if (!student) return res.status(404).json({ error: 'not-found' });
      res.json(student);
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/students/:id/pending', (req, res) => {
  const { section, total, content } = req.body || {};
  if (!section) return res.status(400).json({ error: 'invalid' });
  withDb(db => {
    const student = findStudent(db, req.params.id);
    if (!student) return null;
    student.results = { ...(student.results || {}), [section]: { score: null, total, note: '', pending: true, completedAt: new Date().toISOString() } };
    student.pendingReview = { ...(student.pendingReview || {}), [section]: content };
    saveDb(db);
    return sanitizeStudent(student);
  })
    .then(student => {
      if (!student) return res.status(404).json({ error: 'not-found' });
      res.json(student);
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/students/:id/grade', (req, res) => {
  const { section, score, total, comment } = req.body || {};
  if (!section) return res.status(400).json({ error: 'invalid' });
  withDb(async db => {
    const student = findStudent(db, req.params.id);
    if (!student) return null;
    const previous = student.results?.[section];
    student.results = { ...(student.results || {}), [section]: { score, total, note: comment || '', pending: false, completedAt: previous?.completedAt || new Date().toISOString() } };
    if (student.pendingReview?.[section]) { const rest = { ...student.pendingReview }; delete rest[section]; student.pendingReview = rest; }
    maybeArchiveAttempt(student);
    await finalizeIfComplete(student);
    saveDb(db);
    return sanitizeStudent(student);
  })
    .then(student => {
      if (!student) return res.status(404).json({ error: 'not-found' });
      res.json(student);
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/students/:id/reset', (req, res) => {
  withDb(async db => {
    const student = findStudent(db, req.params.id);
    if (!student) return { error: 'not-found' };
    // Ustoz hali tekshirmagan yoki natija Telegram guruhga hali yuborilmagan bo'lsa,
    // natijalar oynasini yopish (va yangi urinishni boshlash) mumkin emas.
    await finalizeIfComplete(student); // oxirgi imkoniyat sifatida yana bir bor urinib ko'ramiz
    if (!isFullyGraded(student) || !student.telegramSent) {
      saveDb(db);
      return { error: 'not-ready' };
    }
    student.results = {};
    student.pendingReview = {};
    student.telegramSent = false;
    student.telegramError = null;
    saveDb(db);
    return { student: sanitizeStudent(student) };
  })
    .then(result => {
      if (result.error === 'not-found') return res.status(404).json({ error: 'not-found' });
      if (result.error === 'not-ready') return res.status(400).json({ error: 'not-ready' });
      res.json(result.student);
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

// ---------- Savollar banki ----------
app.get('/api/questions', (req, res) => {
  withDb(db => db.questionBank)
    .then(bank => res.json(bank))
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/questions', (req, res) => {
  const { section, prompt, options, answer } = req.body || {};
  if (!section || !prompt) return res.status(400).json({ error: 'invalid' });
  withDb(db => {
    if (!db.questionBank[section] || !Array.isArray(db.questionBank[section])) db.questionBank[section] = [];
    const question = { id: crypto.randomUUID(), prompt };
    if (options) question.options = options;
    if (answer !== undefined) question.answer = answer;
    db.questionBank[section].push(question);
    saveDb(db);
    return db.questionBank;
  })
    .then(bank => res.json(bank))
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.delete('/api/questions/:section/:id', (req, res) => {
  withDb(db => {
    const section = req.params.section;
    db.questionBank[section] = (db.questionBank[section] || []).filter(question => question.id !== req.params.id);
    saveDb(db);
    return db.questionBank;
  })
    .then(bank => res.json(bank))
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

// ---------- Baholash rejimi (AI / Ustoz) ----------
app.get('/api/grading-mode', (req, res) => {
  withDb(db => db.gradingMode)
    .then(mode => res.json({ mode }))
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/grading-mode', (req, res) => {
  const { mode } = req.body || {};
  if (mode !== 'ai' && mode !== 'teacher') return res.status(400).json({ error: 'invalid' });
  withDb(db => {
    db.gradingMode = mode;
    saveDb(db);
    return db.gradingMode;
  })
    .then(savedMode => res.json({ mode: savedMode }))
    .catch(() => res.status(500).json({ error: 'server-error' }));
});
// ---------- Admin: kirish va login/parolni o'zgartirish ----------
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'invalid' });
  withDb(db => {
    if (username.trim().toLowerCase() !== db.adminUsername.toLowerCase()) return { error: 'invalid-username' };
    if (password !== db.adminPassword) return { error: 'invalid-password' };
    return { ok: true, username: db.adminUsername };
  })
    .then(result => {
      if (result.error === 'invalid-username') return res.status(404).json({ error: 'invalid-username' });
      if (result.error === 'invalid-password') return res.status(401).json({ error: 'invalid-password' });
      res.json(result);
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});

app.post('/api/admin/credentials', (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};
  if (!currentPassword) return res.status(400).json({ error: 'invalid' });
  withDb(db => {
    if (currentPassword !== db.adminPassword) return { error: 'invalid-password' };
    const trimmedUsername = (newUsername || '').trim();
    if (trimmedUsername) {
      const conflict = db.students.some(student => student.fullName.toLowerCase() === trimmedUsername.toLowerCase());
      if (conflict) return { error: 'duplicate-username' };
      db.adminUsername = trimmedUsername;
    }
    const trimmedPassword = (newPassword || '').trim();
    if (trimmedPassword) {
      if (trimmedPassword.length < 4) return { error: 'password-too-short' };
      db.adminPassword = trimmedPassword;
    }
    saveDb(db);
    return { ok: true, username: db.adminUsername };
  })
    .then(result => {
      if (result.error === 'invalid-password') return res.status(401).json({ error: 'invalid-password' });
      if (result.error === 'duplicate-username') return res.status(409).json({ error: 'duplicate-username' });
      if (result.error === 'password-too-short') return res.status(400).json({ error: 'password-too-short' });
      res.json(result);
    })
    .catch(() => res.status(500).json({ error: 'server-error' }));
});
// ================= /UMUMIY MA'LUMOTLAR BAZASI =================

// ---------- Amaliy matematika topshiriqlarini AI bilan baholash ----------
app.post('/api/grade-writing', async (req, res) => {
  try {
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY sozlanmagan.' });
    const { answers } = req.body; // [{ prompt, answer }]
    if (!Array.isArray(answers) || !answers.length) {
      return res.status(400).json({ error: 'answers required' });
    }

    const systemPrompt = `Siz matematika o'qituvchisiz. O'quvchining amaliy masalalarga yozma yechimlarini baholaysiz.
Har bir javobni yechimning to'g'riligi, mantiqiy qadamlari va topshiriqqa mosligiga qarab 0 dan 10 gacha ball bilan baholang.
Agar javob bo'sh yoki mutlaqo mos bo'lmasa, 0 ball qo'ying.
Faqat quyidagi JSON formatida javob bering, boshqa hech qanday matn yozmang:
{"items":[{"score": number, "maxScore": 10, "comment": "qisqa fikr o'zbek tilida"}],"totalScore": number, "totalMax": number, "overallComment": "umumiy fikr o'zbek tilida, 1-2 gap"}`;

    const userContent = answers
      .map((a, i) => `Topshiriq ${i + 1}: ${a.prompt}\nO'quvchi javobi: ${a.answer && a.answer.trim() ? a.answer.trim() : '(bo\'sh javob)'}`)
      .join('\n\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    res.json(parsed);
  } catch (err) {
    console.error('grade-writing error:', err.message);
    res.status(500).json({ error: 'AI baholashda xatolik yuz berdi.' });
  }
});

// ---------- Gapirish (Speaking) baholash ----------
app.post('/api/grade-speaking', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'audio file required' });
    const promptsText = req.body.prompts || '';

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: 'whisper-1',
      language: 'ru',
    });

    fs.unlink(req.file.path, () => {});

    const systemPrompt = `Siz rus tili o'qituvchisiz. Sizga o'quvchining ovozli javobi matnga o'girilgan holda (transkripsiya) beriladi.
Talaffuzni to'g'ridan-to'g'ri eshita olmaysiz, shuning uchun grammatika, so'z boyligi, gap tuzilishi va topshiriqqa mosligiga qarab baholang.
0 dan 10 gacha umumiy ball bering. Agar transkripsiya bo'sh yoki mavzuga mutlaqo aloqasi bo'lmasa, past ball bering.
Faqat quyidagi JSON formatida javob bering, boshqa hech narsa yozmang:
{"score": number, "maxScore": 10, "comment": "qisqa fikr o'zbek tilida, 1-2 gap"}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Topshiriq: ${promptsText}\n\nTranskripsiya: ${transcription.text || '(bo\'sh)'}` },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    parsed.transcript = transcription.text || '';
    res.json(parsed);
  } catch (err) {
    console.error('grade-speaking error:', err.message);
    res.status(500).json({ error: 'AI baholashda xatolik yuz berdi.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server ishga tushdi: http://localhost:${PORT}`);
  console.log('Maktabdagi boshqa kompyuterlar shu tarmoqdagi IP orqali ulanadi, masalan: http://192.168.1.XX:' + PORT);
  console.log('Kompyuteringizning tarmoq IP manzilini bilish uchun: Windows -> ipconfig, Mac/Linux -> ifconfig');
});
