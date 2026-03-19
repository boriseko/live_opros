#!/usr/bin/env node

/**
 * Comprehensive integration test suite for Live Opros.
 * Tests all REST API + WebSocket flows end-to-end.
 */

const WebSocket = require('ws');
const BASE = 'http://localhost:3002';
let globalCookie = '';
let passed = 0;
let failed = 0;
const errors = [];

// ── Helpers ──────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Cookie: globalCookie || '' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) globalCookie = sc.split(';')[0];
  return { status: res.status, data: await res.json() };
}

function wsConnect(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3002${path}`, { headers: { Cookie: globalCookie } });
    const msgs = [];
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 5000);
  });
}

function wsSend(ws, type, payload) {
  ws.send(JSON.stringify({ type, payload }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function lastMsg(msgs, type) {
  return [...msgs].reverse().find(m => m.type === type);
}

function allMsgs(msgs, type) {
  return msgs.filter(m => m.type === type);
}

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    errors.push(name);
    console.log(`  ✗ ${name}`);
  }
}

// ── Test Suites ──────────────────────────────────────────

async function testAuth() {
  console.log('\n═══ AUTH ═══');

  // Check not authenticated
  const check1 = await api('/api/auth/check');
  assert(check1.data.authenticated === false, 'Not authenticated initially');

  // Wrong password
  const bad = await api('/api/auth/login', { method: 'POST', body: { password: 'wrong' } });
  assert(bad.status === 401, 'Wrong password returns 401');

  // Empty password
  const empty = await api('/api/auth/login', { method: 'POST', body: { password: '' } });
  assert(empty.status === 400 || empty.status === 401, 'Empty password rejected');

  // Correct password
  const good = await api('/api/auth/login', { method: 'POST', body: { password: '123456' } });
  assert(good.status === 200 && good.data.success, 'Correct password logs in');

  // Now authenticated
  const check2 = await api('/api/auth/check');
  assert(check2.data.authenticated === true, 'Authenticated after login');

  // API accessible
  const quizzes = await api('/api/quizzes');
  assert(quizzes.status === 200, 'API accessible with cookie');

  // Logout
  const logout = await api('/api/auth/logout', { method: 'POST' });
  assert(logout.data.success, 'Logout succeeds');

  // Not authenticated after logout
  const check3 = await api('/api/auth/check');
  assert(check3.data.authenticated === false, 'Not authenticated after logout');

  // API blocked
  const blocked = await api('/api/quizzes');
  assert(blocked.status === 401, 'API blocked after logout');

  // Re-login for further tests
  await api('/api/auth/login', { method: 'POST', body: { password: '123456' } });
}

async function testQuizCRUD() {
  console.log('\n═══ QUIZ CRUD ═══');

  // List quizzes
  const list = await api('/api/quizzes');
  assert(list.data.length >= 1, 'Has seeded quiz');
  assert(list.data[0].blockCount === 5, 'Seeded quiz has 5 blocks');
  assert(list.data[0].questionCount === 25, 'Seeded quiz has 25 questions');

  // Get full quiz
  const full = await api('/api/quizzes/1');
  assert(full.data.blocks.length === 5, 'Full quiz has 5 blocks');
  assert(full.data.blocks[0].questions.length === 5, 'Block 1 has 5 questions');
  assert(full.data.blocks[0].questions[0].type === 'choice', 'First question is choice type');
  assert(full.data.blocks[0].questions[0].time_limit_sec === 60, 'Default time is 60 sec');

  // Quiz not found
  const notFound = await api('/api/quizzes/999');
  assert(notFound.status === 404, 'Non-existent quiz returns 404');

  // Create quiz
  const created = await api('/api/quizzes', { method: 'POST', body: { title: 'Test Quiz' } });
  assert(created.status === 201, 'Create quiz returns 201');
  const newQuizId = created.data.id;

  // Add block
  const block = await api(`/api/quizzes/${newQuizId}/blocks`, { method: 'POST', body: { title: 'Test Block' } });
  assert(block.status === 201, 'Add block returns 201');
  const blockId = block.data.id;

  // Add question (choice)
  const q1 = await api(`/api/quizzes/blocks/${blockId}/questions`, {
    method: 'POST',
    body: { type: 'choice', text: 'Test Q?', options: ['A', 'B', 'C'], correct_answer: 'B', explanation: 'Because B', time_limit_sec: 45 },
  });
  assert(q1.status === 201, 'Add choice question');

  // Add question (multi)
  const q2 = await api(`/api/quizzes/blocks/${blockId}/questions`, {
    method: 'POST',
    body: { type: 'multi', text: 'Multi Q?', options: ['X', 'Y', 'Z'], correct_answer: ['X', 'Z'], explanation: 'XZ', time_limit_sec: 60 },
  });
  assert(q2.status === 201, 'Add multi question');

  // Add question (text)
  const q3 = await api(`/api/quizzes/blocks/${blockId}/questions`, {
    method: 'POST',
    body: { type: 'text', text: 'Write something', options: [], correct_answer: null, explanation: 'Thanks' },
  });
  assert(q3.status === 201, 'Add text question');

  // Add question (scale)
  const q4 = await api(`/api/quizzes/blocks/${blockId}/questions`, {
    method: 'POST',
    body: { type: 'scale', text: 'Rate 1-10', options: ['1','2','3','4','5','6','7','8','9','10'], correct_answer: null },
  });
  assert(q4.status === 201, 'Add scale question');

  // Verify quiz structure
  const verify = await api(`/api/quizzes/${newQuizId}`);
  assert(verify.data.blocks.length === 1, 'Quiz has 1 block');
  assert(verify.data.blocks[0].questions.length === 4, 'Block has 4 questions');

  // Update question
  const upd = await api(`/api/quizzes/questions/${q1.data.id}`, {
    method: 'PUT',
    body: { text: 'Updated Q?', options: ['A', 'B', 'C', 'D'], correct_answer: 'D' },
  });
  assert(upd.data.success, 'Update question');

  // Verify update
  const verify2 = await api(`/api/quizzes/${newQuizId}`);
  const updatedQ = verify2.data.blocks[0].questions[0];
  assert(updatedQ.text === 'Updated Q?', 'Question text updated');
  assert(updatedQ.options.length === 4, 'Options count updated');
  assert(updatedQ.correct_answer === 'D', 'Correct answer updated');

  // Update block title
  const updBlock = await api(`/api/quizzes/blocks/${blockId}`, { method: 'PUT', body: { title: 'Renamed Block' } });
  assert(updBlock.data.success, 'Update block title');

  // Delete question
  const delQ = await api(`/api/quizzes/questions/${q4.data.id}`, { method: 'DELETE' });
  assert(delQ.data.success, 'Delete question');

  const verify3 = await api(`/api/quizzes/${newQuizId}`);
  assert(verify3.data.blocks[0].questions.length === 3, 'Question deleted, 3 remain');

  // Delete quiz
  const delQuiz = await api(`/api/quizzes/${newQuizId}`, { method: 'DELETE' });
  assert(delQuiz.data.success, 'Delete quiz');

  const verify4 = await api(`/api/quizzes/${newQuizId}`);
  assert(verify4.status === 404, 'Deleted quiz returns 404');
}

async function testSessionCRUD() {
  console.log('\n═══ SESSION CRUD ═══');

  // Create session
  const s = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  assert(s.status === 201, 'Create session');
  assert(s.data.status === 'waiting', 'New session is waiting');

  // List sessions
  const list = await api('/api/sessions');
  assert(list.data.length >= 1, 'Sessions list not empty');

  // Get session
  const get = await api(`/api/sessions/${s.data.id}`);
  assert(get.data.quiz_title.includes('GenAI'), 'Session has quiz title');

  // Invalid quiz
  const bad = await api('/api/sessions', { method: 'POST', body: { quizId: 999 } });
  assert(bad.status === 404, 'Session with bad quizId returns 404');
}

async function testFullQuizFlow() {
  console.log('\n═══ FULL QUIZ FLOW (choice questions) ═══');

  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.data.id;

  // Connect admin
  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(300);
  assert(lastMsg(admin.msgs, 'session:state') !== undefined, 'Admin gets session state');

  // Connect 3 participants
  const participants = [];
  for (let i = 0; i < 3; i++) {
    const p = await wsConnect(`/ws/participant?sessionId=${sid}`);
    wsSend(p.ws, 'participant:join', { name: `Участник ${i + 1}` });
    await sleep(100);
    participants.push(p);
  }
  await sleep(200);

  assert(allMsgs(participants[0].msgs, 'participant:joined').length === 1, 'Participant 1 joined');
  assert(allMsgs(participants[2].msgs, 'participant:joined').length === 1, 'Participant 3 joined');

  // Check participant count
  const countMsg = lastMsg(admin.msgs, 'participant:count');
  assert(countMsg && countMsg.payload.online === 3, 'Admin sees 3 participants online');

  // Start session
  wsSend(admin.ws, 'session:start', {});
  await sleep(200);
  assert(lastMsg(participants[0].msgs, 'session:started') !== undefined, 'Participant gets session:started');

  // Start block 1
  wsSend(admin.ws, 'block:start', { blockId: 1 });
  await sleep(100);

  // Question 1 (choice) — all answer correctly
  wsSend(admin.ws, 'question:start', { questionId: 1, questionNumber: 1, totalQuestions: 5 });
  await sleep(300);

  const q1show = lastMsg(participants[0].msgs, 'question:show');
  assert(q1show !== undefined, 'Participant sees question');
  assert(q1show.payload.type === 'choice', 'Question type is choice');
  assert(q1show.payload.timeLimit === 60, 'Time limit is 60');
  assert(q1show.payload.options.length === 4, 'Has 4 options');

  // Participant 1: correct answer
  wsSend(participants[0].ws, 'answer:submit', { questionId: 1, answer: 'Уверенный, но фактически неверный ответ' });
  // Participant 2: wrong answer
  wsSend(participants[1].ws, 'answer:submit', { questionId: 1, answer: 'Ошибка в программном коде модели' });
  // Participant 3: correct answer
  wsSend(participants[2].ws, 'answer:submit', { questionId: 1, answer: 'Уверенный, но фактически неверный ответ' });
  await sleep(300);

  assert(lastMsg(participants[0].msgs, 'answer:accepted') !== undefined, 'P1 answer accepted');
  assert(lastMsg(participants[1].msgs, 'answer:accepted') !== undefined, 'P2 answer accepted');

  // Admin gets live stats
  const stats = lastMsg(admin.msgs, 'stats:live');
  assert(stats !== undefined, 'Admin gets live stats');
  assert(stats.payload.totalAnswered === 3, 'Stats show 3 answered');

  // Double submit prevention
  wsSend(participants[0].ws, 'answer:submit', { questionId: 1, answer: 'Different' });
  await sleep(200);
  assert(lastMsg(participants[0].msgs, 'answer:already_submitted') !== undefined, 'Double submit prevented');

  // Reveal
  wsSend(admin.ws, 'question:reveal', {});
  await sleep(300);

  const reveal1 = lastMsg(participants[0].msgs, 'question:reveal');
  assert(reveal1.payload.isCorrect === true, 'P1 correct');
  const reveal2 = lastMsg(participants[1].msgs, 'question:reveal');
  assert(reveal2.payload.isCorrect === false, 'P2 incorrect');
  assert(reveal1.payload.explanation.length > 0, 'Has explanation');
  assert(reveal1.payload.correctAnswer !== null, 'Has correct answer');

  // Next question
  wsSend(admin.ws, 'question:next', {});
  await sleep(200);
  assert(lastMsg(participants[0].msgs, 'question:next') !== undefined, 'Participants get question:next');

  // Question 2
  wsSend(admin.ws, 'question:start', { questionId: 2, questionNumber: 2, totalQuestions: 5 });
  await sleep(300);
  const q2shows = allMsgs(participants[0].msgs, 'question:show');
  assert(q2shows.length === 2, 'Participant received 2 question:show (Q1 + Q2, no restart bug)');
  assert(q2shows[1].payload.questionId === 2, 'Second question:show is Q2');

  // End session
  wsSend(admin.ws, 'session:end', {});
  await sleep(200);
  assert(lastMsg(participants[0].msgs, 'session:ended') !== undefined, 'Participants get session:ended');

  // Check results
  const results = await api(`/api/sessions/${sid}/results`);
  assert(results.data.totalParticipants === 3, 'Results: 3 participants');
  assert(results.data.totalResponses === 3, 'Results: 3 responses (only Q1 answered)');
  assert(results.data.questionStats[0].correctCount === 2, 'Results: Q1 has 2 correct');
  assert(results.data.questionStats[0].correctRate > 0.6, 'Results: Q1 correct rate > 60%');
  assert(Object.keys(results.data.questionStats[0].distribution).length === 2, 'Results: Q1 has 2 unique answers');
  assert(results.data.participants[0].correctCount >= 0, 'Results: participant has correct count');

  // Cleanup
  admin.ws.close();
  participants.forEach(p => p.ws.close());
}

async function testMultiChoiceFlow() {
  console.log('\n═══ MULTI-CHOICE QUESTION ═══');

  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.data.id;

  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(200);

  const p = await wsConnect(`/ws/participant?sessionId=${sid}`);
  wsSend(p.ws, 'participant:join', { name: 'MultiTest' });
  await sleep(200);

  wsSend(admin.ws, 'session:start', {});
  await sleep(200);

  // Q4 in block 1 is multi-choice
  wsSend(admin.ws, 'block:start', { blockId: 1 });
  await sleep(100);
  wsSend(admin.ws, 'question:start', { questionId: 4, questionNumber: 4, totalQuestions: 5 });
  await sleep(300);

  const qShow = lastMsg(p.msgs, 'question:show');
  assert(qShow.payload.type === 'multi', 'Multi question type');

  // Submit multi-answer (correct: first 3 options)
  const correctAnswers = [
    'Может создавать текст, изображения, код и музыку',
    'Основан на обучении на больших объёмах данных',
    'Может «понимать» контекст разговора',
  ];
  wsSend(p.ws, 'answer:submit', { questionId: 4, answer: correctAnswers });
  await sleep(200);
  assert(lastMsg(p.msgs, 'answer:accepted') !== undefined, 'Multi answer accepted');

  wsSend(admin.ws, 'question:reveal', {});
  await sleep(200);
  const reveal = lastMsg(p.msgs, 'question:reveal');
  assert(reveal.payload.isCorrect === true, 'Multi-choice: all correct = isCorrect true');

  wsSend(admin.ws, 'session:end', {});
  await sleep(100);
  admin.ws.close();
  p.ws.close();
}

async function testTextAndScaleFlow() {
  console.log('\n═══ TEXT & SCALE QUESTIONS ═══');

  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.data.id;

  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(200);

  const p = await wsConnect(`/ws/participant?sessionId=${sid}`);
  wsSend(p.ws, 'participant:join', { name: 'TextTest' });
  await sleep(200);

  wsSend(admin.ws, 'session:start', {});
  await sleep(200);

  // Block 3, Q5 = text question (id 15)
  wsSend(admin.ws, 'block:start', { blockId: 3 });
  await sleep(100);
  wsSend(admin.ws, 'question:start', { questionId: 15, questionNumber: 5, totalQuestions: 5 });
  await sleep(300);

  const qText = lastMsg(p.msgs, 'question:show');
  assert(qText.payload.type === 'text', 'Text question type received');
  assert(qText.payload.options.length === 0, 'Text question has no options');

  wsSend(p.ws, 'answer:submit', { questionId: 15, answer: 'Автоматизация отчетов с помощью ИИ' });
  await sleep(200);
  assert(lastMsg(p.msgs, 'answer:accepted') !== undefined, 'Text answer accepted');

  wsSend(admin.ws, 'question:reveal', {});
  await sleep(200);
  const revealText = lastMsg(p.msgs, 'question:reveal');
  assert(revealText.payload.isCorrect === null, 'Text: isCorrect is null (neutral)');
  assert(revealText.payload.correctAnswer === null, 'Text: no correct answer');

  // Block 5, Q2 = scale question (id 24)
  wsSend(admin.ws, 'question:next', {});
  await sleep(100);
  wsSend(admin.ws, 'block:start', { blockId: 5 });
  await sleep(100);
  wsSend(admin.ws, 'question:start', { questionId: 24, questionNumber: 2, totalQuestions: 3 });
  await sleep(300);

  const qScale = lastMsg(p.msgs, 'question:show');
  assert(qScale.payload.type === 'scale', 'Scale question type received');
  assert(qScale.payload.options.length === 10, 'Scale has 10 options (1-10)');

  wsSend(p.ws, 'answer:submit', { questionId: 24, answer: '8' });
  await sleep(200);
  assert(lastMsg(p.msgs, 'answer:accepted') !== undefined, 'Scale answer accepted');

  wsSend(admin.ws, 'question:reveal', {});
  await sleep(200);
  const revealScale = lastMsg(p.msgs, 'question:reveal');
  assert(revealScale.payload.isCorrect === null, 'Scale: isCorrect is null (neutral)');

  wsSend(admin.ws, 'session:end', {});
  await sleep(100);
  admin.ws.close();
  p.ws.close();
}

async function testDisplaySync() {
  console.log('\n═══ DISPLAY (PROJECTOR) SYNC ═══');

  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.data.id;

  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(200);

  // Connect display
  const display = await wsConnect(`/ws/display?sessionId=${sid}`);
  await sleep(300);
  assert(lastMsg(display.msgs, 'session:state') !== undefined, 'Display gets session state');

  // Connect participant
  const p = await wsConnect(`/ws/participant?sessionId=${sid}`);
  wsSend(p.ws, 'participant:join', { name: 'DisplayTest' });
  await sleep(200);

  // Display gets participant count
  const dispCount = lastMsg(display.msgs, 'participant:count');
  assert(dispCount !== undefined, 'Display gets participant count');

  wsSend(admin.ws, 'session:start', {});
  await sleep(200);

  wsSend(admin.ws, 'block:start', { blockId: 1 });
  await sleep(100);
  wsSend(admin.ws, 'question:start', { questionId: 1, questionNumber: 1, totalQuestions: 5 });
  await sleep(300);

  // Display gets question
  assert(lastMsg(display.msgs, 'question:show') !== undefined, 'Display gets question:show');

  // Participant answers
  wsSend(p.ws, 'answer:submit', { questionId: 1, answer: 'Уверенный, но фактически неверный ответ' });
  await sleep(200);

  // Display gets live stats
  assert(lastMsg(display.msgs, 'stats:live') !== undefined, 'Display gets stats:live');

  // Reveal
  wsSend(admin.ws, 'question:reveal', {});
  await sleep(200);
  const dispReveal = lastMsg(display.msgs, 'question:reveal');
  assert(dispReveal !== undefined, 'Display gets question:reveal');
  assert(dispReveal.payload.distribution !== undefined, 'Display reveal has distribution');
  assert(dispReveal.payload.correctAnswer !== null, 'Display reveal has correct answer');

  wsSend(admin.ws, 'session:end', {});
  await sleep(100);
  admin.ws.close();
  display.ws.close();
  p.ws.close();
}

async function testEdgeCases() {
  console.log('\n═══ EDGE CASES ═══');

  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.data.id;

  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(200);

  // Participant joins finished session
  wsSend(admin.ws, 'session:start', {});
  await sleep(100);
  wsSend(admin.ws, 'session:end', {});
  await sleep(200);

  const pLate = await wsConnect(`/ws/participant?sessionId=${sid}`);
  await sleep(300);
  const endedMsg = lastMsg(pLate.msgs, 'session:ended');
  assert(endedMsg !== undefined, 'Late joiner to finished session gets session:ended');
  pLate.ws.close();

  // Answer when no question is open
  const session2 = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid2 = session2.data.id;

  const admin2 = await wsConnect('/ws/admin');
  wsSend(admin2.ws, 'session:join', { sessionId: sid2 });
  await sleep(200);

  const p2 = await wsConnect(`/ws/participant?sessionId=${sid2}`);
  wsSend(p2.ws, 'participant:join', { name: 'EdgeCase' });
  await sleep(200);

  wsSend(admin2.ws, 'session:start', {});
  await sleep(100);

  // Try to answer without question open
  wsSend(p2.ws, 'answer:submit', { questionId: 1, answer: 'Test' });
  await sleep(200);
  const errMsg = lastMsg(p2.msgs, 'error');
  assert(errMsg !== undefined, 'Error when answering without open question');

  // Participant with empty name
  const pEmpty = await wsConnect(`/ws/participant?sessionId=${sid2}`);
  wsSend(pEmpty.ws, 'participant:join', { name: '' });
  await sleep(200);
  const nameErr = lastMsg(pEmpty.msgs, 'error');
  assert(nameErr !== undefined, 'Error for empty participant name');
  pEmpty.ws.close();

  // Participant with very long name
  const pLong = await wsConnect(`/ws/participant?sessionId=${sid2}`);
  wsSend(pLong.ws, 'participant:join', { name: 'A'.repeat(100) });
  await sleep(200);
  const longErr = lastMsg(pLong.msgs, 'error');
  assert(longErr !== undefined, 'Error for name > 50 chars');
  pLong.ws.close();

  // WS admin without cookie should fail
  try {
    const badAdmin = await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:3002/ws/admin');
      ws.on('open', () => resolve({ success: true }));
      ws.on('error', () => resolve({ success: false }));
      ws.on('close', () => resolve({ success: false }));
      setTimeout(() => resolve({ success: false }), 2000);
    });
    assert(!badAdmin.success, 'Admin WS rejected without cookie');
  } catch {
    assert(true, 'Admin WS rejected without cookie');
  }

  wsSend(admin2.ws, 'session:end', {});
  await sleep(100);
  admin.ws.close();
  admin2.ws.close();
  p2.ws.close();
}

async function testReconnect() {
  console.log('\n═══ RECONNECT ═══');

  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.data.id;

  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(200);

  const p = await wsConnect(`/ws/participant?sessionId=${sid}`);
  wsSend(p.ws, 'participant:join', { name: 'ReconnectUser' });
  await sleep(200);

  const joinMsg = lastMsg(p.msgs, 'participant:joined');
  const pid = joinMsg.payload.participantId;
  assert(pid > 0, 'Got participant ID');

  wsSend(admin.ws, 'session:start', {});
  await sleep(100);

  // Disconnect
  p.ws.close();
  await sleep(200);

  // Reconnect with same participantId
  const p2 = await wsConnect(`/ws/participant?sessionId=${sid}`);
  wsSend(p2.ws, 'participant:join', { name: 'ReconnectUser', participantId: pid });
  await sleep(300);

  const rejoin = lastMsg(p2.msgs, 'participant:joined');
  assert(rejoin.payload.reconnected === true, 'Reconnect recognized');
  assert(rejoin.payload.participantId === pid, 'Same participant ID preserved');

  wsSend(admin.ws, 'session:end', {});
  await sleep(100);
  admin.ws.close();
  p2.ws.close();
}

async function testBlockFlow() {
  console.log('\n═══ FULL BLOCK FLOW (5 questions) ═══');

  const session = await api('/api/sessions', { method: 'POST', body: { quizId: 1 } });
  const sid = session.data.id;

  const admin = await wsConnect('/ws/admin');
  wsSend(admin.ws, 'session:join', { sessionId: sid });
  await sleep(200);

  const p = await wsConnect(`/ws/participant?sessionId=${sid}`);
  wsSend(p.ws, 'participant:join', { name: 'BlockTest' });
  await sleep(200);

  wsSend(admin.ws, 'session:start', {});
  await sleep(200);

  // Go through all 5 questions in block 1
  wsSend(admin.ws, 'block:start', { blockId: 1 });
  await sleep(100);

  for (let i = 0; i < 5; i++) {
    const qId = i + 1;
    wsSend(admin.ws, 'question:start', { questionId: qId, questionNumber: i + 1, totalQuestions: 5 });
    await sleep(200);

    // Answer something
    const qShow = lastMsg(p.msgs, 'question:show');
    const answer = qShow.payload.type === 'multi'
      ? [qShow.payload.options[0]]
      : qShow.payload.options ? qShow.payload.options[0] : 'test';
    wsSend(p.ws, 'answer:submit', { questionId: qId, answer });
    await sleep(200);

    wsSend(admin.ws, 'question:reveal', {});
    await sleep(200);

    if (i < 4) {
      wsSend(admin.ws, 'question:next', {});
      await sleep(100);
    }
  }

  // Block end
  wsSend(admin.ws, 'block:end', {});
  await sleep(300);

  const blockEnd = lastMsg(p.msgs, 'block:end');
  assert(blockEnd !== undefined, 'Participant gets block:end');
  assert(blockEnd.payload.totalQuestions === 5, 'Block end shows 5 questions');
  assert(typeof blockEnd.payload.yourScore === 'number', 'Block end has score');

  // Check question shows count (should be exactly 5, no restart)
  const totalQShows = allMsgs(p.msgs, 'question:show');
  assert(totalQShows.length === 5, `Got exactly 5 question:show messages (got ${totalQShows.length})`);

  wsSend(admin.ws, 'session:end', {});
  await sleep(100);
  admin.ws.close();
  p.ws.close();
}

async function testStaticPages() {
  console.log('\n═══ STATIC PAGES ═══');

  const pages = ['/', '/login.html', '/display.html', '/admin.html'];
  for (const page of pages) {
    const res = await fetch(BASE + page);
    assert(res.status === 200 || res.status === 302, `${page} loads (${res.status})`);
  }

  // Admin page redirects to login when not authenticated
  const oldCookie = globalCookie;
  globalCookie = '';
  const res = await fetch(BASE + '/admin.html', { redirect: 'manual' });
  assert(res.status === 302 || res.status === 200, '/admin.html handles unauthed');
  globalCookie = oldCookie;
}

// ── Run All ──────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     LIVE OPROS — FULL TEST SUITE         ║');
  console.log('╚══════════════════════════════════════════╝');

  try {
    await testAuth();
    await testQuizCRUD();
    await testSessionCRUD();
    await testStaticPages();
    await testFullQuizFlow();
    await testMultiChoiceFlow();
    await testTextAndScaleFlow();
    await testDisplaySync();
    await testEdgeCases();
    await testReconnect();
    await testBlockFlow();
  } catch (e) {
    console.error('\n  FATAL ERROR:', e.message);
    failed++;
  }

  console.log('\n══════════════════════════════════════════');
  console.log(`  PASSED: ${passed}`);
  console.log(`  FAILED: ${failed}`);
  if (errors.length > 0) {
    console.log(`  FAILURES:`);
    errors.forEach(e => console.log(`    - ${e}`));
  }
  console.log('══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

run();
