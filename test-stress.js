#!/usr/bin/env node

/**
 * Stress test: 20 participants with chaotic real-world behavior.
 * Simulates a real training room with all the chaos.
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
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

function wsSend(ws, type, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function last(msgs, type) { return [...msgs].reverse().find(m => m.type === type); }
function count(msgs, type) { return msgs.filter(m => m.type === type).length; }
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

let passed = 0, failed = 0;
const errors = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; errors.push(name); console.log(`  ✗ ${name}`); }
}

// ── 20 Participants with personalities ───────────────────

const PEOPLE = [
  { name: 'Иванов А.К.', behavior: 'normal' },
  { name: 'Петрова М.В.', behavior: 'normal' },
  { name: 'Сидоров Д.Н.', behavior: 'normal' },
  { name: 'Козлова О.А.', behavior: 'normal' },
  { name: 'Морозов И.П.', behavior: 'normal' },
  { name: 'Новикова Е.С.', behavior: 'normal' },
  { name: 'Волков Р.А.', behavior: 'normal' },
  { name: 'Лебедева Н.И.', behavior: 'normal' },
  { name: 'Кузнецов П.Д.', behavior: 'slow' },       // Answers late, sometimes misses
  { name: 'Соколова А.В.', behavior: 'slow' },       // Same
  { name: 'Попов Г.Е.', behavior: 'disconnector' },   // Will disconnect/reconnect
  { name: 'Михайлова Т.К.', behavior: 'disconnector' },
  { name: 'Федоров В.С.', behavior: 'double_tab' },   // Opens 2 connections
  { name: 'Егорова Л.М.', behavior: 'spammer' },      // Tries double submit
  { name: 'Тимофеев О.Б.', behavior: 'normal' },
  { name: 'Крылова Д.А.', behavior: 'normal' },
  { name: 'Белов С.Н.', behavior: 'late_joiner' },    // Joins after session starts
  { name: 'Комарова И.Г.', behavior: 'late_joiner' },
  { name: 'Орлов М.Ю.', behavior: 'unicode' },        // Weird name
  { name: 'Жукова🎯А.П.', behavior: 'normal' },       // Emoji in name
];

async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  STRESS TEST — 20 participants, chaotic behavior ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Setup ────────────────────────────────────────────

  await api('/api/auth/login', { method: 'POST', body: { password: '123456' } });
  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.id;
  console.log(`Session: ${sid}\n`);

  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(300);

  const display = await wsConnect(`/ws/display?sessionId=${sid}`);
  await sleep(200);

  // ── Phase 1: 16 participants join before start ───────

  console.log('═══ PHASE 1: JOIN (16 normal + 2 late joiners + 2 edge cases) ═══\n');

  const players = [];
  const lateJoiners = [];

  for (const p of PEOPLE) {
    if (p.behavior === 'late_joiner') {
      lateJoiners.push(p);
      continue;
    }

    const conn = await wsConnect(`/ws/participant?sessionId=${sid}`);
    wsSend(conn.ws, 'participant:join', { name: p.name });
    await sleep(50);
    const joinMsg = last(conn.msgs, 'participant:joined');
    players.push({ ...p, conn, pid: joinMsg?.payload?.participantId });
  }
  await sleep(300);

  const countBefore = last(admin.msgs, 'participant:count');
  assert(countBefore?.payload?.online === 18, `18 participants online before start (got ${countBefore?.payload?.online})`);

  // ── Phase 2: Double-tab user ─────────────────────────

  console.log('\n═══ PHASE 2: EDGE CASES ═══\n');

  const doubleTabber = players.find(p => p.behavior === 'double_tab');
  if (doubleTabber) {
    // Open second connection with same name (new participant)
    const conn2 = await wsConnect(`/ws/participant?sessionId=${sid}`);
    wsSend(conn2.ws, 'participant:join', { name: doubleTabber.name });
    await sleep(200);
    const join2 = last(conn2.msgs, 'participant:joined');
    assert(join2 !== undefined, `Double-tab: second connection accepted as new participant`);
    assert(join2?.payload?.participantId !== doubleTabber.pid, `Double-tab: gets different participant ID`);
    // Close the duplicate
    conn2.ws.close();
    await sleep(100);
  }

  // ── Disconnector test ────────────────────────────────

  const disc = players.find(p => p.behavior === 'disconnector');
  if (disc) {
    const oldPid = disc.pid;
    disc.conn.ws.close();
    await sleep(200);

    // Reconnect with same pid
    disc.conn = await wsConnect(`/ws/participant?sessionId=${sid}`);
    wsSend(disc.conn.ws, 'participant:join', { name: disc.name, participantId: oldPid });
    await sleep(200);
    const rejoin = last(disc.conn.msgs, 'participant:joined');
    assert(rejoin?.payload?.reconnected === true, `Disconnector: reconnected successfully`);
    assert(rejoin?.payload?.participantId === oldPid, `Disconnector: same participant ID`);
  }

  // ── Phase 3: Start session, late joiners arrive ──────

  console.log('\n═══ PHASE 3: SESSION START + LATE JOINERS ═══\n');

  wsSend(admin.ws, 'session:start', {});
  await sleep(300);

  // Late joiners arrive after session starts
  for (const p of lateJoiners) {
    const conn = await wsConnect(`/ws/participant?sessionId=${sid}`);
    wsSend(conn.ws, 'participant:join', { name: p.name });
    await sleep(100);
    const joinMsg = last(conn.msgs, 'participant:joined');
    players.push({ ...p, conn, pid: joinMsg?.payload?.participantId });
  }
  await sleep(200);

  const countAfter = last(admin.msgs, 'participant:count');
  // 18 original + 2 late = 20, but double_tab duplicate was closed, still only 20 unique
  assert(countAfter?.payload?.total >= 20, `20+ participants total after late join (got ${countAfter?.payload?.total})`);
  console.log(`  Participants: ${countAfter?.payload?.online} online / ${countAfter?.payload?.total} total`);

  // ── Phase 4: Run through block 1 (5 questions) ───────

  console.log('\n═══ PHASE 4: BLOCK 1 — 5 QUESTIONS WITH 20 PEOPLE ═══\n');

  wsSend(admin.ws, 'block:start', { blockId: 1 });
  await sleep(150);

  const quiz = await api('/api/quizzes/1');
  const block1 = quiz.blocks[0];

  for (let qIdx = 0; qIdx < block1.questions.length; qIdx++) {
    const q = block1.questions[qIdx];
    wsSend(admin.ws, 'question:start', {
      questionId: q.id, questionNumber: qIdx + 1, totalQuestions: block1.questions.length,
    });
    await sleep(200);

    // Verify all active participants got the question
    let receivedCount = 0;
    for (const p of players) {
      if (last(p.conn.msgs, 'question:show')?.payload?.questionId === q.id) receivedCount++;
    }

    console.log(`  Q${qIdx + 1}: "${q.text.substring(0, 45)}..." — received by ${receivedCount}/${players.length}`);

    // All participants answer (with different behaviors)
    const answerPromises = players.map(async (p, i) => {
      // Slow: 30% chance of not answering
      if (p.behavior === 'slow' && Math.random() < 0.3) return;

      // Stagger answers to simulate real timing (0-500ms)
      await sleep(Math.random() * 500);

      if (q.type === 'text') {
        wsSend(p.conn.ws, 'answer:submit', { questionId: q.id, answer: `Ответ от ${p.name}` });
      } else if (q.type === 'scale') {
        wsSend(p.conn.ws, 'answer:submit', { questionId: q.id, answer: String(Math.floor(Math.random() * 10) + 1) });
      } else if (q.type === 'multi') {
        const pick = q.options.slice(0, Math.floor(Math.random() * 3) + 1);
        wsSend(p.conn.ws, 'answer:submit', { questionId: q.id, answer: pick });
      } else {
        wsSend(p.conn.ws, 'answer:submit', { questionId: q.id, answer: rand(q.options) });
      }

      // Spammer: try to submit again immediately
      if (p.behavior === 'spammer') {
        await sleep(10);
        wsSend(p.conn.ws, 'answer:submit', { questionId: q.id, answer: rand(q.options || ['test']) });
      }
    });

    await Promise.all(answerPromises);
    await sleep(400);

    // Check stats
    const stats = last(admin.msgs, 'stats:live');
    const displayStats = last(display.msgs, 'stats:live');
    console.log(`    Answered: ${stats?.payload?.totalAnswered}/${stats?.payload?.totalParticipants} | Display synced: ${!!displayStats}`);

    // Spammer check — should have answer:already_submitted
    const spammer = players.find(p => p.behavior === 'spammer');
    if (spammer && q.type !== 'text') {
      const dupeMsg = count(spammer.conn.msgs, 'answer:already_submitted');
      if (qIdx === 0) { // Only check first question
        assert(dupeMsg > 0, `Spammer double-submit blocked (got ${dupeMsg} rejections)`);
      }
    }

    // Reveal
    wsSend(admin.ws, 'question:reveal', {});
    await sleep(300);

    // Check all players got reveal
    let revealCount = 0;
    for (const p of players) {
      if (count(p.conn.msgs, 'question:reveal') > qIdx) revealCount++;
    }
    console.log(`    Reveal received: ${revealCount}/${players.length}`);

    // Next
    if (qIdx < block1.questions.length - 1) {
      wsSend(admin.ws, 'question:next', {});
      await sleep(150);
    }
  }

  // Block end
  wsSend(admin.ws, 'block:end', {});
  await sleep(300);

  let blockEndCount = 0;
  for (const p of players) {
    if (last(p.conn.msgs, 'block:end')) blockEndCount++;
  }
  assert(blockEndCount === players.length, `All ${players.length} participants got block:end (got ${blockEndCount})`);

  // ── Phase 5: Disconnector mid-question ───────────────

  console.log('\n═══ PHASE 5: DISCONNECT MID-QUESTION ═══\n');

  wsSend(admin.ws, 'block:start', { blockId: 2 });
  await sleep(100);
  wsSend(admin.ws, 'question:start', { questionId: 6, questionNumber: 1, totalQuestions: 5 });
  await sleep(300);

  // Disconnect 2 participants mid-question
  const disc1 = players.find(p => p.behavior === 'disconnector');
  const disc2 = players.filter(p => p.behavior === 'disconnector')[1];

  if (disc1) {
    disc1.conn.ws.close();
    console.log(`  ${disc1.name} disconnected mid-question`);
  }
  if (disc2) {
    disc2.conn.ws.close();
    console.log(`  ${disc2.name} disconnected mid-question`);
  }
  await sleep(300);

  // Other participants still answer
  let answeredMidDisc = 0;
  for (const p of players) {
    if (p.behavior === 'disconnector') continue;
    if (p.conn.ws.readyState !== 1) continue;
    wsSend(p.conn.ws, 'answer:submit', { questionId: 6, answer: rand(quiz.blocks[1].questions[0].options) });
    answeredMidDisc++;
  }
  await sleep(300);

  const midStats = last(admin.msgs, 'stats:live');
  console.log(`  Active participants answered: ${midStats?.payload?.totalAnswered}`);
  assert(midStats?.payload?.totalAnswered >= answeredMidDisc - 2, `Answers from connected participants accepted`);

  // Reconnect disconnectors
  if (disc1) {
    disc1.conn = await wsConnect(`/ws/participant?sessionId=${sid}`);
    wsSend(disc1.conn.ws, 'participant:join', { name: disc1.name, participantId: disc1.pid });
    await sleep(200);
    assert(last(disc1.conn.msgs, 'participant:joined')?.payload?.reconnected === true, `${disc1.name} reconnected after mid-question drop`);
  }

  // Reveal + end
  wsSend(admin.ws, 'question:reveal', {});
  await sleep(200);
  wsSend(admin.ws, 'session:end', {});
  await sleep(300);

  // ── Phase 6: Verify Results ──────────────────────────

  console.log('\n═══ PHASE 6: RESULTS VERIFICATION ═══\n');

  const results = await api(`/api/sessions/${sid}/results`);

  assert(results.totalParticipants >= 20, `Results: ${results.totalParticipants} participants (expected 20+)`);
  assert(results.totalResponses > 0, `Results: ${results.totalResponses} total responses`);
  assert(results.questionStats.length === 25, `Results: all 25 questions in stats`);

  // Check no duplicate responses (spammer should have only 1 per question)
  const spammer = results.participants.find(p => p.name === 'Егорова Л.М.');
  if (spammer) {
    // Each question answered at most once
    const maxPerQ = {};
    spammer.responses.forEach(r => {
      maxPerQ[r.question_id] = (maxPerQ[r.question_id] || 0) + 1;
    });
    const dupes = Object.values(maxPerQ).some(c => c > 1);
    assert(!dupes, `Spammer has no duplicate responses per question`);
  }

  // Late joiners should have answers
  const lateP = results.participants.find(p => p.name === 'Белов С.Н.');
  assert(lateP && lateP.totalAnswered > 0, `Late joiner has answers: ${lateP?.totalAnswered}`);

  // Unicode/emoji name preserved
  const emojiP = results.participants.find(p => p.name.includes('🎯'));
  assert(emojiP !== undefined, `Emoji in name preserved: ${emojiP?.name}`);

  // Display got all events
  const displayQuestions = count(display.msgs, 'question:show');
  assert(displayQuestions >= 5, `Display received ${displayQuestions} questions`);

  const displayReveals = count(display.msgs, 'question:reveal');
  assert(displayReveals >= 5, `Display received ${displayReveals} reveals`);

  // All ended
  let endedCount = 0;
  for (const p of players) {
    if (p.conn.ws.readyState !== 1) continue; // Skip closed
    if (last(p.conn.msgs, 'session:ended')) endedCount++;
  }
  console.log(`  Players notified of end: ${endedCount}`);

  // Leaderboard
  console.log('\n  Leaderboard:');
  results.participants
    .sort((a, b) => b.correctCount - a.correctCount)
    .slice(0, 5)
    .forEach((p, i) => {
      console.log(`    ${i + 1}. ${p.name} — ${p.correctCount}/${p.totalAnswered}`);
    });

  // ── Cleanup ──────────────────────────────────────────

  admin.ws.close();
  display.ws.close();
  players.forEach(p => { try { p.conn.ws.close(); } catch {} });

  // ── Summary ──────────────────────────────────────────

  console.log('\n' + '═'.repeat(55));
  console.log(`  PASSED: ${passed}`);
  console.log(`  FAILED: ${failed}`);
  if (errors.length > 0) {
    console.log('  FAILURES:');
    errors.forEach(e => console.log(`    - ${e}`));
  }
  console.log('═'.repeat(55) + '\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
