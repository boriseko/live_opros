#!/usr/bin/env node

/**
 * Full simulation: Admin conducts a quiz with 5 participants.
 * Goes through ALL 25 questions across 5 blocks.
 * Each participant has a personality (some smart, some random, some slow).
 */

const WebSocket = require('ws');
const BASE = 'http://localhost:3002';
let globalCookie = '';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Cookie: globalCookie || '' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) globalCookie = sc.split(';')[0];
  return res.json();
}

function wsConnect(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3002${path}`, { headers: { Cookie: globalCookie } });
    const msgs = [];
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    ws.on('error', reject);
  });
}

function wsSend(ws, type, payload) { ws.send(JSON.stringify({ type, payload })); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function last(msgs, type) { return [...msgs].reverse().find(m => m.type === type); }

// ── Participant Personalities ────────────────────────────

const PARTICIPANTS = [
  { name: 'Иванов А.К.', style: 'smart' },       // Almost always correct
  { name: 'Петрова М.В.', style: 'smart' },       // Almost always correct
  { name: 'Сидоров Д.Н.', style: 'average' },     // 50/50
  { name: 'Козлова О.А.', style: 'random' },      // Random answers
  { name: 'Морозов И.П.', style: 'slow' },        // Sometimes doesn't answer in time
];

function pickAnswer(question, style) {
  const { type, options, text } = question;

  if (type === 'text') {
    const textAnswers = [
      'Автоматизация отчётов',
      'Создание шаблонов документов',
      'Анализ данных о браке продукции',
      'Составление протоколов совещаний',
      'Подготовка технических инструкций',
      'Нужно больше практики',
      'Очень полезный тренинг!',
      'Добавить больше примеров из нашей отрасли',
      'Хочу попробовать написать промпт для своих задач',
      'Всё было понятно и интересно',
    ];
    return textAnswers[Math.floor(Math.random() * textAnswers.length)];
  }

  if (type === 'scale') {
    if (style === 'smart') return String(Math.floor(Math.random() * 3) + 8);  // 8-10
    if (style === 'average') return String(Math.floor(Math.random() * 4) + 5); // 5-8
    return String(Math.floor(Math.random() * 10) + 1); // 1-10
  }

  if (type === 'multi') {
    if (style === 'smart') {
      // Pick 3 random options (might be correct)
      const shuffled = [...options].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, Math.min(3, options.length));
    }
    // Others pick 1-2 random
    const shuffled = [...options].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.floor(Math.random() * 2) + 1);
  }

  // choice
  if (style === 'smart') {
    // 80% chance pick first option (often correct in seed data)
    return Math.random() < 0.8 ? options[1] : options[Math.floor(Math.random() * options.length)];
  }
  if (style === 'average') {
    return Math.random() < 0.5 ? options[1] : options[Math.floor(Math.random() * options.length)];
  }
  // random / slow
  return options[Math.floor(Math.random() * options.length)];
}

// ── Main Simulation ──────────────────────────────────────

async function simulate() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   LIVE OPROS — FULL SESSION SIMULATION           ║');
  console.log('║   5 participants, 5 blocks, 25 questions         ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Setup ──────────────────────────────────────────────

  await api('/api/auth/login', { method: 'POST', body: { password: '123456' } });
  console.log('✓ Admin logged in\n');

  const quiz = await api('/api/quizzes/1');
  console.log(`Quiz: "${quiz.title}"`);
  console.log(`Blocks: ${quiz.blocks.length}, Questions: ${quiz.blocks.reduce((s, b) => s + b.questions.length, 0)}\n`);

  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.id;
  console.log(`Session created: id=${sid}\n`);

  // ── Connect Admin ──────────────────────────────────────

  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(300);
  console.log('✓ Admin connected to session\n');

  // ── Connect Display ────────────────────────────────────

  const display = await wsConnect(`/ws/display?sessionId=${sid}`);
  await sleep(200);
  console.log('✓ Display (projector) connected\n');

  // ── Connect Participants ───────────────────────────────

  console.log('Participants joining...');
  const players = [];
  for (const p of PARTICIPANTS) {
    const conn = await wsConnect(`/ws/participant?sessionId=${sid}`);
    wsSend(conn.ws, 'participant:join', { name: p.name });
    await sleep(150);
    const joinMsg = last(conn.msgs, 'participant:joined');
    players.push({ ...p, conn, pid: joinMsg?.payload?.participantId });
    console.log(`  → ${p.name} (${p.style}) joined, id=${joinMsg?.payload?.participantId}`);
  }
  await sleep(300);

  const countMsg = last(admin.msgs, 'participant:count');
  console.log(`\n✓ Participants online: ${countMsg?.payload?.online}/${countMsg?.payload?.total}\n`);

  // ── Start Session ──────────────────────────────────────

  wsSend(admin.ws, 'session:start', {});
  await sleep(300);
  console.log('✓ Session started\n');
  console.log('═'.repeat(60));

  // ── Go Through All Blocks ──────────────────────────────

  let totalCorrect = {};
  players.forEach(p => totalCorrect[p.name] = 0);

  for (let bIdx = 0; bIdx < quiz.blocks.length; bIdx++) {
    const block = quiz.blocks[bIdx];
    console.log(`\n▸ БЛОК ${bIdx + 1}: ${block.title} (${block.questions.length} вопросов)`);
    console.log('─'.repeat(60));

    wsSend(admin.ws, 'block:start', { blockId: block.id });
    await sleep(150);

    for (let qIdx = 0; qIdx < block.questions.length; qIdx++) {
      const question = block.questions[qIdx];
      const qLabel = `Q${qIdx + 1}`;

      wsSend(admin.ws, 'question:start', {
        questionId: question.id,
        questionNumber: qIdx + 1,
        totalQuestions: block.questions.length,
      });
      await sleep(300);

      // Verify all participants received the question
      const received = players.filter(p => {
        const msg = last(p.conn.msgs, 'question:show');
        return msg && msg.payload.questionId === question.id;
      });

      const typeLabel = { choice: 'ВЫБОР', multi: 'МУЛЬТИ', text: 'ТЕКСТ', scale: 'ШКАЛА' };
      console.log(`\n  ${qLabel} [${typeLabel[question.type]}] ${question.text.substring(0, 60)}...`);
      console.log(`  Получили вопрос: ${received.length}/${players.length}`);

      // Participants answer
      const answers = [];
      for (const player of players) {
        // "slow" player skips ~30% of questions
        if (player.style === 'slow' && Math.random() < 0.3) {
          answers.push({ name: player.name, answer: null, skipped: true });
          continue;
        }

        const answer = pickAnswer(question, player.style);
        wsSend(player.conn.ws, 'answer:submit', { questionId: question.id, answer });
        await sleep(50);
        answers.push({ name: player.name, answer, skipped: false });
      }
      await sleep(300);

      // Check stats
      const statsMsg = last(admin.msgs, 'stats:live');
      const answeredCount = answers.filter(a => !a.skipped).length;
      console.log(`  Ответили: ${statsMsg?.payload?.totalAnswered || '?'}/${players.length} (ожидали: ${answeredCount})`);

      if (question.type === 'choice' || question.type === 'multi') {
        const dist = statsMsg?.payload?.distribution || {};
        const distStr = Object.entries(dist)
          .map(([k, v]) => `${v}×"${k.substring(0, 25)}${k.length > 25 ? '...' : ''}"`)
          .join(', ');
        console.log(`  Распределение: ${distStr}`);
      }

      // Display should have stats
      const displayStats = last(display.msgs, 'stats:live');

      // Reveal answer
      wsSend(admin.ws, 'question:reveal', {});
      await sleep(300);

      // Check reveal results per participant
      const revealResults = [];
      for (const player of players) {
        const reveal = last(player.conn.msgs, 'question:reveal');
        if (reveal) {
          const status = reveal.payload.isCorrect === true ? '✓'
            : reveal.payload.isCorrect === false ? '✗'
            : '○';
          revealResults.push({ name: player.name, status, isCorrect: reveal.payload.isCorrect });
          if (reveal.payload.isCorrect === true) totalCorrect[player.name]++;
        }
      }

      if (question.type === 'choice' || question.type === 'multi') {
        const correctStr = revealResults.map(r => `${r.name.split(' ')[0]}:${r.status}`).join('  ');
        console.log(`  Результаты: ${correctStr}`);
      } else {
        console.log(`  Тип ${question.type} — без проверки правильности`);
      }

      // Display should have reveal
      const displayReveal = last(display.msgs, 'question:reveal');
      if (displayReveal && question.type === 'choice') {
        console.log(`  Проектор: правильный ответ = "${String(displayReveal.payload.correctAnswer).substring(0, 30)}..."`);
      }

      // Next (unless last question in block)
      if (qIdx < block.questions.length - 1) {
        wsSend(admin.ws, 'question:next', {});
        await sleep(150);
      }
    }

    // Block end
    wsSend(admin.ws, 'block:end', {});
    await sleep(300);

    console.log(`\n  ── Итоги блока ──`);
    for (const player of players) {
      const blockEnd = last(player.conn.msgs, 'block:end');
      if (blockEnd) {
        console.log(`  ${player.name}: ${blockEnd.payload.yourScore}/${blockEnd.payload.totalQuestions}`);
      }
    }

    const adminBlockEnd = last(admin.msgs, 'block:ended');
    if (adminBlockEnd) {
      console.log(`  Средний балл: ${adminBlockEnd.payload.avgScore}`);
    }
  }

  // ── End Session ────────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  wsSend(admin.ws, 'session:end', {});
  await sleep(300);

  // Verify everyone got session:ended
  const allEnded = players.every(p => last(p.conn.msgs, 'session:ended'));
  const displayEnded = last(display.msgs, 'session:ended');

  console.log(`\n✓ Сессия завершена`);
  console.log(`  Все участники уведомлены: ${allEnded ? 'Да' : 'НЕТ!'}`);
  console.log(`  Проектор уведомлён: ${displayEnded ? 'Да' : 'НЕТ!'}`);

  // ── Check Results via API ──────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log('\n▸ РЕЗУЛЬТАТЫ (API)\n');

  const results = await api(`/api/sessions/${sid}/results`);

  console.log(`Участников: ${results.totalParticipants}`);
  console.log(`Всего ответов: ${results.totalResponses}`);

  console.log('\nПо участникам:');
  results.participants
    .sort((a, b) => b.correctCount - a.correctCount)
    .forEach((p, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      console.log(`  ${medal} ${p.name}: ${p.correctCount} правильных из ${p.totalAnswered} ответов`);
    });

  console.log('\nПо вопросам:');
  results.questionStats.forEach((qs, i) => {
    if (qs.questionType === 'text' || qs.questionType === 'scale') {
      console.log(`  Q${i + 1} [${qs.questionType}] ${qs.questionText.substring(0, 45)}... — ${qs.totalAnswered} ответов`);
    } else {
      const pct = qs.totalAnswered > 0 ? Math.round(qs.correctRate * 100) : 0;
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      console.log(`  Q${i + 1} [${qs.questionType}] ${bar} ${pct}% (${qs.correctCount}/${qs.totalAnswered}) — ${qs.questionText.substring(0, 35)}...`);
    }
  });

  // ── Validation Summary ─────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log('\n▸ ВАЛИДАЦИЯ\n');

  const checks = [
    ['Участников в результатах = 5', results.totalParticipants === 5],
    ['Есть ответы', results.totalResponses > 0],
    ['Все 25 вопросов в статистике', results.questionStats.length === 25],
    ['Text вопросы без correct rate', results.questionStats.filter(q => q.questionType === 'text').every(q => q.correctCount === 0)],
    ['Scale вопросы без correct rate', results.questionStats.filter(q => q.questionType === 'scale').every(q => q.correctCount === 0)],
    ['Choice вопросы имеют distribution', results.questionStats.filter(q => q.questionType === 'choice').every(q => Object.keys(q.distribution).length > 0)],
    ['У каждого участника есть ответы', results.participants.every(p => p.totalAnswered > 0)],
    ['Все уведомлены о конце сессии', allEnded && !!displayEnded],
  ];

  let ok = 0;
  checks.forEach(([label, pass]) => {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (pass) ok++;
  });

  console.log(`\n  Результат: ${ok}/${checks.length} проверок пройдено`);

  // ── Cleanup ────────────────────────────────────────────

  admin.ws.close();
  display.ws.close();
  players.forEach(p => p.conn.ws.close());

  console.log('\n✓ Все соединения закрыты\n');
  process.exit(ok === checks.length ? 0 : 1);
}

simulate().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
