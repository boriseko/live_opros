document.addEventListener('DOMContentLoaded', () => {
  // ── State ────────────────────────────────────────────

  let ws = null;
  let currentSession = null;
  let currentQuiz = null;
  let currentBlockIdx = 0;
  let currentQuestionIdx = -1; // -1 = no question shown yet
  let questionState = 'idle'; // idle, open, locked, revealed

  // ── DOM ──────────────────────────────────────────────

  const viewDashboard = document.getElementById('view-dashboard');
  const viewLive = document.getElementById('view-live');
  const connDot = document.getElementById('conn-dot');
  const connText = document.getElementById('conn-text');

  // ── Logout ───────────────────────────────────────────

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  // ── Load Dashboard ───────────────────────────────────

  async function loadDashboard() {
    viewDashboard.style.display = '';
    viewLive.classList.remove('active');

    // Load quizzes
    const quizzes = await api('/api/quizzes');
    const grid = document.getElementById('quiz-grid');
    grid.innerHTML = '';

    quizzes.forEach((q) => {
      const card = document.createElement('div');
      card.className = 'quiz-card';
      card.innerHTML = `
        <div class="quiz-card-info">
          <h3>${esc(q.title)}</h3>
          <div class="quiz-meta">
            <span>${q.blockCount} блоков</span>
            <span>${q.questionCount} вопросов</span>
          </div>
        </div>
        <div class="quiz-card-actions">
          <button class="btn btn-outline btn-edit">Редактировать</button>
          <button class="btn btn-accent btn-start">Создать сессию</button>
          <button class="btn btn-ghost btn-del-quiz" style="color:var(--red)">Удалить</button>
        </div>
      `;
      card.querySelector('.btn-start').addEventListener('click', () => createSession(q.id));
      card.querySelector('.btn-edit').addEventListener('click', () => openEditor(q.id));
      card.querySelector('.btn-del-quiz').addEventListener('click', async () => {
        if (!confirm(`Удалить квиз «${q.title}»? Все блоки и вопросы будут удалены.`)) return;
        await api(`/api/quizzes/${q.id}`, { method: 'DELETE' });
        toast('Квиз удалён', 'info');
        loadDashboard();
      });
      grid.appendChild(card);
    });

    // Load sessions
    const sessions = await api('/api/sessions');
    const list = document.getElementById('sessions-list');
    list.innerHTML = '';

    sessions.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'session-row';
      const statusBadge = s.status === 'waiting' ? 'badge-yellow'
        : s.status === 'active' ? 'badge-green'
        : 'badge-accent';
      const statusText = s.status === 'waiting' ? 'Ожидание'
        : s.status === 'active' ? 'Активна'
        : 'Завершена';

      row.innerHTML = `
        <div class="session-info">
          <span class="badge ${statusBadge}">${statusText}</span>
          <span>${esc(s.quiz_title)}</span>
          <span class="text-slate" style="font-size:13px">${s.participantCount} уч.</span>
        </div>
        <div class="flex gap-sm">
          ${s.status !== 'finished' ? `<button class="btn btn-outline btn-connect" data-id="${s.id}">Подключиться</button>` : ''}
          <button class="btn btn-ghost btn-results" data-id="${s.id}">Результаты</button>
        </div>
      `;

      const connectBtn = row.querySelector('.btn-connect');
      if (connectBtn) {
        connectBtn.addEventListener('click', () => joinSession(s.id));
      }

      row.querySelector('.btn-results').addEventListener('click', () => showResults(s.id));

      list.appendChild(row);
    });
  }

  // ── Create Session ───────────────────────────────────

  async function createSession(quizId) {
    const session = await api('/api/sessions', {
      method: 'POST',
      body: { quizId },
    });
    toast('Сессия создана!', 'success');
    joinSession(session.id);
  }

  // ── Join Session (live control) ──────────────────────

  async function joinSession(sessionId) {
    // Save for page refresh recovery
    sessionStorage.setItem('lo_admin_session', sessionId);

    // Load quiz data
    const session = await api(`/api/sessions/${sessionId}`);
    if (!session || !session.quiz_id) {
      toast('Сессия не найдена', 'error');
      sessionStorage.removeItem('lo_admin_session');
      return;
    }
    const quiz = await api(`/api/quizzes/${session.quiz_id}`);
    if (!quiz || !quiz.blocks) {
      toast('Квиз удалён', 'error');
      sessionStorage.removeItem('lo_admin_session');
      return;
    }

    currentSession = session;
    currentQuiz = quiz;
    currentBlockIdx = 0;
    currentQuestionIdx = -1;
    questionState = 'idle';

    // Switch to live view
    viewDashboard.style.display = 'none';
    viewLive.classList.add('active');

    // Show session URL
    const urlBox = document.getElementById('session-url-box');
    urlBox.style.display = '';
    const participantUrl = `${location.origin}/?s=${sessionId}`;
    document.getElementById('session-url').textContent = participantUrl;

    document.getElementById('btn-copy-url').addEventListener('click', () => {
      navigator.clipboard.writeText(participantUrl);
      toast('Ссылка скопирована!', 'success');
    });

    // Build block navigator
    buildBlockNav();

    // Connect WebSocket
    connectAdminWs(sessionId);

    // Update button states
    updateControls();
  }

  // ── WebSocket ────────────────────────────────────────

  function connectAdminWs(sessionId) {
    if (ws) ws.close();

    ws = new WsClient(`/ws/admin`);

    ws.on('_connected', () => {
      connDot.classList.remove('offline');
      connText.textContent = '';
      ws.send('session:join', { sessionId });
    });

    ws.on('_disconnected', () => {
      connDot.classList.add('offline');
      connText.textContent = 'Переподключение...';
    });

    ws.on('session:state', (data) => {
      // Restore state on reconnect / page refresh
      if (data.session.status === 'active') {
        currentSession.status = 'active';
        questionState = data.session.question_state || 'idle';

        // Find current block/question index
        if (data.quiz && data.session.current_block_id) {
          const bIdx = data.quiz.blocks.findIndex(b => b.id === data.session.current_block_id);
          if (bIdx >= 0) {
            currentBlockIdx = bIdx;
            if (data.session.current_question_id) {
              const qIdx = data.quiz.blocks[bIdx].questions.findIndex(q => q.id === data.session.current_question_id);
              if (qIdx >= 0) currentQuestionIdx = qIdx;
            }
          }
          buildBlockNav();
        }
        updateControls();
      }
    });

    ws.on('participant:count', (data) => {
      document.getElementById('stat-participants').textContent = data.online;
      document.getElementById('stat-participants-detail').textContent =
        `${data.online} онлайн / ${data.total} всего`;
    });

    ws.on('stats:live', (data) => {
      document.getElementById('stat-answered').textContent = data.totalAnswered;
      document.getElementById('stat-answered-detail').textContent =
        `из ${data.totalParticipants}`;
      renderDistribution(data.distribution);
    });

    ws.on('session:started', () => {
      if (currentSession) currentSession.status = 'active';
      updateControls();
    });

    ws.on('question:started', (data) => {
      questionState = 'open';
      showLiveQuestion(data);
      updateControls();
    });

    ws.on('question:locked', () => {
      questionState = 'locked';
      updateControls();
    });

    ws.on('question:revealed', (data) => {
      questionState = 'revealed';
      // Show explanation
      document.getElementById('live-q-explanation').style.display = '';
      document.getElementById('live-q-exp-text').textContent = data.explanation || '';
      // Mark correct in options
      const optEls = document.querySelectorAll('#live-q-options .option-preview');
      optEls.forEach((el) => {
        const text = el.dataset.value;
        const correct = data.correctAnswer;
        if (Array.isArray(correct) ? correct.includes(text) : text === correct) {
          el.classList.add('correct');
        }
      });
      updateControls();
    });

    ws.on('question:next', () => {
      questionState = 'idle';
      document.getElementById('live-question').style.display = 'none';
      document.getElementById('stat-answered').textContent = '0';
      document.getElementById('stat-answered-detail').textContent = '';
      clearDistribution();
      updateControls();
    });

    ws.on('block:started', (data) => {
      // Don't reset currentQuestionIdx here — it's already managed by
      // btn-end-block and block nav click handlers. Resetting here causes
      // the "restart from question 1" bug because server echoes block:started
      // back to admin after the first question:start.
      toast(`Блок: ${data.blockTitle}`, 'info');
      updateControls();
    });

    ws.on('block:ended', (data) => {
      toast(`Блок завершён. Средний балл: ${data.avgScore}`, 'success');
    });

    ws.on('session:ended', () => {
      toast('Сессия завершена!', 'success');
      if (ws) ws.close();
      ws = null;
      currentSession = null;
      currentQuiz = null;
      currentBlockIdx = 0;
      currentQuestionIdx = -1;
      questionState = 'idle';
      sessionStorage.removeItem('lo_admin_session');
      loadDashboard();
    });

    ws.on('error', (data) => {
      toast(data.message, 'error');
    });
  }

  // ── Controls ─────────────────────────────────────────

  document.getElementById('btn-start-session').addEventListener('click', () => {
    ws.send('session:start', {});
    document.getElementById('btn-start-session').style.display = 'none';
  });

  document.getElementById('btn-show-question').addEventListener('click', () => {
    const block = currentQuiz.blocks[currentBlockIdx];
    if (!block) return;

    currentQuestionIdx++;
    if (currentQuestionIdx >= block.questions.length) {
      toast('Все вопросы в блоке показаны. Завершите блок или перейдите к следующему.', 'info');
      currentQuestionIdx = block.questions.length - 1;
      return;
    }

    const question = block.questions[currentQuestionIdx];

    // If first question, start block
    if (currentQuestionIdx === 0) {
      ws.send('block:start', { blockId: block.id });
    }

    ws.send('question:start', {
      questionId: question.id,
      blockTitle: block.title,
      questionNumber: currentQuestionIdx + 1,
      totalQuestions: block.questions.length,
    });
  });

  document.getElementById('btn-lock-question').addEventListener('click', () => {
    ws.send('question:lock', {});
  });

  document.getElementById('btn-reveal').addEventListener('click', () => {
    ws.send('question:reveal', {});
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    ws.send('question:next', {});
  });

  document.getElementById('btn-end-block').addEventListener('click', () => {
    ws.send('block:end', {});
    // Move to next block
    currentBlockIdx++;
    currentQuestionIdx = -1;
    if (currentBlockIdx >= currentQuiz.blocks.length) {
      toast('Все блоки пройдены!', 'success');
    }
    buildBlockNav();
    updateControls();
  });

  document.getElementById('btn-end-session').addEventListener('click', () => {
    if (confirm('Завершить сессию? Это действие нельзя отменить.')) {
      ws.send('session:end', {});
    }
  });

  document.getElementById('btn-back-dashboard').addEventListener('click', () => {
    if (ws) ws.close();
    sessionStorage.removeItem('lo_admin_session');
    loadDashboard();
  });

  function updateControls() {
    const isWaiting = currentSession && currentSession.status === 'waiting';
    const isActive = currentSession && currentSession.status === 'active';

    const btnStart = document.getElementById('btn-start-session');
    const btnShow = document.getElementById('btn-show-question');
    const btnLock = document.getElementById('btn-lock-question');
    const btnReveal = document.getElementById('btn-reveal');
    const btnNext = document.getElementById('btn-next');
    const btnEndBlock = document.getElementById('btn-end-block');

    btnStart.style.display = isWaiting ? '' : 'none';

    btnShow.disabled = questionState !== 'idle' || !isActive;
    btnLock.style.display = questionState === 'open' ? '' : 'none';
    btnReveal.disabled = questionState !== 'open' && questionState !== 'locked';
    btnNext.disabled = questionState !== 'revealed';

    // Show end block after last question in block is revealed
    const block = currentQuiz && currentQuiz.blocks[currentBlockIdx];
    if (block && currentQuestionIdx >= block.questions.length - 1 && questionState === 'revealed') {
      btnEndBlock.style.display = '';
    } else {
      btnEndBlock.style.display = 'none';
    }
  }

  // ── Live Question Display ────────────────────────────

  function showLiveQuestion(data) {
    const card = document.getElementById('live-question');
    card.style.display = '';

    document.getElementById('live-q-label').textContent =
      `Вопрос ${data.questionNumber || ''} из ${data.totalQuestions || ''}`;
    document.getElementById('live-q-text').textContent = data.text;
    document.getElementById('live-q-explanation').style.display = 'none';

    const optionsEl = document.getElementById('live-q-options');
    optionsEl.innerHTML = '';

    if (data.options && data.options.length > 0) {
      data.options.forEach((opt) => {
        const div = document.createElement('div');
        div.className = 'option-preview';
        div.dataset.value = opt;
        div.textContent = opt;
        optionsEl.appendChild(div);
      });
    } else {
      optionsEl.innerHTML = `<div class="option-preview" style="color:var(--slate)">Текстовый ответ / шкала</div>`;
    }

    // Reset distribution
    document.getElementById('stat-answered').textContent = '0';
    clearDistribution();
  }

  // ── Distribution ─────────────────────────────────────

  function renderDistribution(distribution) {
    const container = document.getElementById('live-distribution');
    const entries = Object.entries(distribution);
    if (entries.length === 0) return;

    const maxCount = Math.max(...entries.map(([, v]) => v), 1);

    container.innerHTML = '';
    entries.forEach(([label, count]) => {
      const pct = Math.round((count / maxCount) * 100);
      const row = document.createElement('div');
      row.className = 'dist-row';
      row.innerHTML = `
        <div class="dist-label" title="${esc(label)}">${esc(truncate(label, 20))}</div>
        <div class="dist-bar-bg">
          <div class="dist-bar" style="width:${pct}%"></div>
        </div>
        <div class="dist-count">${count}</div>
      `;
      container.appendChild(row);
    });
  }

  function clearDistribution() {
    document.getElementById('live-distribution').innerHTML =
      '<p class="text-slate" style="font-size:13px">Ожидание ответов...</p>';
  }

  // ── Block Navigator ──────────────────────────────────

  function buildBlockNav() {
    const nav = document.getElementById('block-nav');
    nav.innerHTML = '';

    if (!currentQuiz) return;

    currentQuiz.blocks.forEach((block, idx) => {
      const item = document.createElement('div');
      item.className = 'block-nav-item';
      if (idx === currentBlockIdx) item.classList.add('active');
      if (idx < currentBlockIdx) item.classList.add('completed');

      item.innerHTML = `
        <span class="block-nav-num">${idx < currentBlockIdx ? '\u2713' : idx + 1}</span>
        <span>${esc(block.title)}</span>
        <span class="text-slate" style="font-size:12px;margin-left:auto">${block.questions.length} вопр.</span>
      `;

      item.addEventListener('click', () => {
        if (questionState !== 'idle') {
          toast('Сначала завершите текущий вопрос', 'error');
          return;
        }
        currentBlockIdx = idx;
        currentQuestionIdx = -1;
        buildBlockNav();
        updateControls();
      });

      nav.appendChild(item);
    });
  }

  // ── Helpers ──────────────────────────────────────────

  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    return res.json();
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function truncate(str, len) {
    return str && str.length > len ? str.slice(0, len) + '...' : str;
  }

  function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'slideOut 0.3s var(--ease) forwards';
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  // ── Results View ──────────────────────────────────────

  const viewResults = document.getElementById('view-results');

  document.getElementById('btn-back-from-results').addEventListener('click', () => {
    viewResults.style.display = 'none';
    viewDashboard.style.display = '';
  });

  async function showResults(sessionId) {
    const data = await api(`/api/sessions/${sessionId}/results`);
    if (!data || !data.session) {
      toast('Результаты не найдены', 'error');
      return;
    }

    viewDashboard.style.display = 'none';
    viewResults.style.display = '';

    document.getElementById('results-title').textContent =
      `Результаты: ${data.session.quiz_title}`;

    const content = document.getElementById('results-content');
    content.innerHTML = '';

    // Summary stats
    const summary = document.createElement('div');
    summary.className = 'flex gap-lg mb-lg';
    summary.innerHTML = `
      <div class="stat-card" style="flex:1">
        <div class="stat-label">Участников</div>
        <div class="stat-value">${data.totalParticipants}</div>
      </div>
      <div class="stat-card" style="flex:1">
        <div class="stat-label">Ответов</div>
        <div class="stat-value">${data.totalResponses}</div>
      </div>
      <div class="stat-card" style="flex:1">
        <div class="stat-label">Статус</div>
        <div class="stat-value" style="font-size:16px">${data.session.status === 'finished' ? 'Завершена' : 'Активна'}</div>
      </div>
    `;
    content.appendChild(summary);

    // Per-question stats
    if (data.questionStats && data.questionStats.length > 0) {
      const qSection = document.createElement('div');
      qSection.innerHTML = '<h2 class="mb-md">По вопросам</h2>';

      data.questionStats.forEach((qs, i) => {
        const card = document.createElement('div');
        card.className = 'card mb-md';
        const correctPct = qs.totalAnswered > 0
          ? Math.round(qs.correctRate * 100) + '%'
          : '—';

        let distHtml = '';
        if (qs.distribution && Object.keys(qs.distribution).length > 0) {
          const maxVal = Math.max(...Object.values(qs.distribution), 1);
          distHtml = Object.entries(qs.distribution).map(([label, count]) => {
            const pct = Math.round((count / maxVal) * 100);
            return `<div class="dist-row">
              <div class="dist-label" title="${esc(label)}">${esc(label.length > 30 ? label.slice(0, 30) + '...' : label)}</div>
              <div class="dist-bar-bg"><div class="dist-bar" style="width:${pct}%"></div></div>
              <div class="dist-count">${count}</div>
            </div>`;
          }).join('');
        }

        card.innerHTML = `
          <div class="flex justify-between items-center mb-sm">
            <h4 style="font-size:14px"><span class="text-accent text-mono">Q${i + 1}</span> ${esc(qs.questionText)}</h4>
            ${qs.questionType !== 'text' && qs.questionType !== 'scale'
              ? `<span class="badge ${qs.correctRate >= 0.7 ? 'badge-green' : qs.correctRate >= 0.4 ? 'badge-yellow' : 'badge-red'}">${correctPct} верно</span>`
              : '<span class="badge badge-accent">Открытый</span>'}
          </div>
          <div style="font-size:13px;color:var(--slate);margin-bottom:8px">Ответили: ${qs.totalAnswered}</div>
          ${distHtml}
        `;
        qSection.appendChild(card);
      });

      content.appendChild(qSection);
    }

    // Per-participant results
    if (data.participants && data.participants.length > 0) {
      const pSection = document.createElement('div');
      pSection.innerHTML = '<h2 class="mb-md mt-xl">По участникам</h2>';

      const table = document.createElement('div');
      data.participants.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'session-row';
        row.innerHTML = `
          <div class="session-info">
            <strong>${esc(p.name)}</strong>
            <span class="text-slate" style="font-size:13px">${p.totalAnswered} ответов</span>
          </div>
          <span class="badge badge-accent">${p.correctCount} правильных</span>
        `;
        table.appendChild(row);
      });
      pSection.appendChild(table);
      content.appendChild(pSection);
    }

    if (data.totalParticipants === 0) {
      content.innerHTML += '<p class="text-slate text-center mt-xl">Нет данных — в сессии не было участников.</p>';
    }
  }

  // ── Quiz Editor ───────────────────────────────────────

  const viewEditor = document.getElementById('view-editor');
  let editorQuizId = null;

  // Create new quiz
  document.getElementById('btn-create-quiz').addEventListener('click', async () => {
    const title = prompt('Название нового квиза:');
    if (!title) return;
    const quiz = await api('/api/quizzes', { method: 'POST', body: { title } });
    toast('Квиз создан!', 'success');
    openEditor(quiz.id);
  });

  document.getElementById('btn-back-from-editor').addEventListener('click', () => {
    viewEditor.style.display = 'none';
    viewDashboard.style.display = '';
    loadDashboard();
  });

  document.getElementById('btn-add-block').addEventListener('click', async () => {
    if (!editorQuizId) return;
    const title = prompt('Название нового блока:');
    if (!title) return;
    await api(`/api/quizzes/${editorQuizId}/blocks`, { method: 'POST', body: { title } });
    renderEditor();
  });

  async function openEditor(quizId) {
    editorQuizId = quizId;
    viewDashboard.style.display = 'none';
    viewEditor.style.display = '';
    await renderEditor();
  }

  async function renderEditor() {
    const quiz = await api(`/api/quizzes/${editorQuizId}`);
    document.getElementById('editor-title').textContent = quiz.title;

    const container = document.getElementById('editor-blocks');
    container.innerHTML = '';

    if (quiz.blocks.length === 0) {
      container.innerHTML = '<p class="text-slate text-center mt-xl">Пока нет блоков. Нажмите «+ Добавить блок» чтобы начать.</p>';
      return;
    }

    quiz.blocks.forEach((block, bIdx) => {
      const blockEl = document.createElement('div');
      blockEl.className = 'editor-block';

      // Block header
      blockEl.innerHTML = `
        <div class="editor-block-header">
          <span class="block-num">${bIdx + 1}</span>
          <input type="text" class="editor-block-title" value="${esc(block.title)}">
          <div class="editor-block-actions">
            <button class="btn btn-outline btn-save-block" style="font-size:12px">Сохранить блок</button>
            <button class="btn btn-ghost btn-del-block" style="font-size:12px;color:var(--red)">Удалить</button>
          </div>
        </div>
        <div class="eq-list"></div>
        <button class="btn btn-ghost btn-add-q" style="font-size:13px;margin-top:8px">+ Добавить вопрос</button>
      `;

      // Block events
      blockEl.querySelector('.btn-save-block').addEventListener('click', async () => {
        const title = blockEl.querySelector('.editor-block-title').value.trim();
        if (!title) return;
        await api(`/api/quizzes/blocks/${block.id}`, { method: 'PUT', body: { title } });
        toast('Блок сохранён', 'success');
      });

      blockEl.querySelector('.btn-del-block').addEventListener('click', async () => {
        if (!confirm(`Удалить блок «${block.title}» и все его вопросы?`)) return;
        await api(`/api/quizzes/blocks/${block.id}`, { method: 'DELETE' });
        renderEditor();
      });

      blockEl.querySelector('.btn-add-q').addEventListener('click', async () => {
        await api(`/api/quizzes/blocks/${block.id}/questions`, {
          method: 'POST',
          body: { type: 'choice', text: 'Новый вопрос', options: ['Вариант 1', 'Вариант 2'], correct_answer: 'Вариант 1', explanation: '', time_limit_sec: 60 },
        });
        renderEditor();
      });

      // Render questions
      const list = blockEl.querySelector('.eq-list');
      block.questions.forEach((q, qIdx) => {
        list.appendChild(buildQuestionCard(q, qIdx));
      });

      container.appendChild(blockEl);
    });
  }

  function buildQuestionCard(q, qIdx) {
    const card = document.createElement('div');
    card.className = 'eq-card';

    const isChoice = q.type === 'choice' || q.type === 'multi';
    const options = q.options || [];
    const correct = q.correct_answer;

    // Build options HTML
    let optionsHtml = '';
    if (isChoice) {
      const inputType = q.type === 'multi' ? 'checkbox' : 'radio';
      const rows = options.map((opt) => {
        const checked = Array.isArray(correct) ? correct.includes(opt) : correct === opt;
        return `<div class="eq-option-row">
          <input type="${inputType}" name="q${q.id}_correct" ${checked ? 'checked' : ''}>
          <input type="text" value="${esc(opt)}" class="eq-opt-val">
          <button class="eq-option-remove" title="Удалить вариант">&times;</button>
        </div>`;
      }).join('');

      optionsHtml = `
        <div class="eq-options-section">
          <div class="eq-options-label">Варианты ответов (отметьте правильные):</div>
          <div class="eq-opts-list">${rows}</div>
          <button class="btn btn-ghost eq-add-opt" style="font-size:12px;margin-top:6px">+ Вариант</button>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="eq-card-top">
        <span class="eq-num">Q${qIdx + 1}</span>
        <select class="eq-type-select">
          <option value="choice" ${q.type === 'choice' ? 'selected' : ''}>Один ответ</option>
          <option value="multi" ${q.type === 'multi' ? 'selected' : ''}>Несколько ответов</option>
          <option value="text" ${q.type === 'text' ? 'selected' : ''}>Текст</option>
          <option value="scale" ${q.type === 'scale' ? 'selected' : ''}>Шкала 1-10</option>
        </select>
        <div class="eq-actions">
          <button class="btn btn-accent eq-save">Сохранить</button>
          <button class="btn btn-ghost eq-del" style="color:var(--red)">Удалить</button>
        </div>
      </div>
      <textarea class="eq-text-field" rows="2" placeholder="Текст вопроса...">${esc(q.text)}</textarea>
      ${optionsHtml}
      <div class="eq-bottom">
        <div class="eq-field">
          <label>Объяснение</label>
          <textarea rows="2" class="eq-expl" placeholder="Показывается после раскрытия ответа...">${esc(q.explanation || '')}</textarea>
        </div>
        <div class="eq-field small">
          <label>Время (сек)</label>
          <input type="number" class="eq-time" value="${q.time_limit_sec || 30}" min="5" max="300">
        </div>
      </div>
    `;

    // Type change — save and re-render
    card.querySelector('.eq-type-select').addEventListener('change', async () => {
      const newType = card.querySelector('.eq-type-select').value;
      const text = card.querySelector('.eq-text-field').value.trim();
      const explanation = card.querySelector('.eq-expl').value.trim();
      const time_limit_sec = parseInt(card.querySelector('.eq-time').value) || 30;

      let newOptions = [];
      let newCorrect = null;
      if (newType === 'choice') {
        newOptions = ['Вариант 1', 'Вариант 2'];
        newCorrect = 'Вариант 1';
      } else if (newType === 'multi') {
        newOptions = ['Вариант 1', 'Вариант 2'];
        newCorrect = ['Вариант 1'];
      } else if (newType === 'scale') {
        newOptions = ['1','2','3','4','5','6','7','8','9','10'];
      }

      await api(`/api/quizzes/questions/${q.id}`, {
        method: 'PUT',
        body: { type: newType, text: text || q.text, options: newOptions, correct_answer: newCorrect, explanation, time_limit_sec },
      });
      toast('Тип изменён', 'success');
      renderEditor();
    });

    // Save
    card.querySelector('.eq-save').addEventListener('click', async () => {
      const type = card.querySelector('.eq-type-select').value;
      const text = card.querySelector('.eq-text-field').value.trim();
      const explanation = card.querySelector('.eq-expl').value.trim();
      const time_limit_sec = parseInt(card.querySelector('.eq-time').value) || 30;

      let newOptions = [];
      let newCorrect = null;

      if (type === 'choice' || type === 'multi') {
        card.querySelectorAll('.eq-option-row').forEach((row) => {
          const val = row.querySelector('.eq-opt-val').value.trim();
          if (!val) return;
          newOptions.push(val);
          const inp = row.querySelector('input[type="radio"], input[type="checkbox"]');
          if (inp && inp.checked) {
            if (type === 'multi') {
              if (!newCorrect) newCorrect = [];
              newCorrect.push(val);
            } else {
              newCorrect = val;
            }
          }
        });
      } else if (type === 'scale') {
        newOptions = ['1','2','3','4','5','6','7','8','9','10'];
      }

      await api(`/api/quizzes/questions/${q.id}`, {
        method: 'PUT',
        body: { type, text, options: newOptions, correct_answer: newCorrect, explanation, time_limit_sec },
      });
      toast('Вопрос сохранён', 'success');
    });

    // Delete
    card.querySelector('.eq-del').addEventListener('click', async () => {
      if (!confirm('Удалить вопрос?')) return;
      await api(`/api/quizzes/questions/${q.id}`, { method: 'DELETE' });
      renderEditor();
    });

    // Add option
    const addOptBtn = card.querySelector('.eq-add-opt');
    if (addOptBtn) {
      addOptBtn.addEventListener('click', () => {
        const list = card.querySelector('.eq-opts-list');
        const type = card.querySelector('.eq-type-select').value;
        const n = list.children.length + 1;
        const row = document.createElement('div');
        row.className = 'eq-option-row';
        row.innerHTML = `
          <input type="${type === 'multi' ? 'checkbox' : 'radio'}" name="q${q.id}_correct">
          <input type="text" value="Вариант ${n}" class="eq-opt-val">
          <button class="eq-option-remove" title="Удалить вариант">&times;</button>
        `;
        row.querySelector('.eq-option-remove').addEventListener('click', () => row.remove());
        list.appendChild(row);
      });
    }

    // Remove option
    card.querySelectorAll('.eq-option-remove').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('.eq-option-row').remove());
    });

    return card;
  }

  // ── Init ─────────────────────────────────────────────

  // Recover active session after page refresh
  const savedSession = sessionStorage.getItem('lo_admin_session');
  if (savedSession) {
    joinSession(Number(savedSession));
  } else {
    loadDashboard();
  }
});
