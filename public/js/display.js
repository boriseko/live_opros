document.addEventListener('DOMContentLoaded', () => {
  // ── State ────────────────────────────────────────────

  let timerInterval = null;
  let currentQuestion = null;
  let lastDistribution = {};

  const screens = document.querySelectorAll('.d-screen');
  const letters = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'];

  function showScreen(id) {
    screens.forEach((s) => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  // ── Session ID ───────────────────────────────────────

  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = Number(urlParams.get('s') || urlParams.get('session'));

  if (!sessionId) {
    document.querySelector('.d-subtitle').textContent =
      'Добавьте ?s=ID_СЕССИИ к URL';
    return;
  }

  // Set join URL
  const participantUrl = `${location.origin}/?s=${sessionId}`;
  document.getElementById('d-join-url').textContent = participantUrl;

  // ── WebSocket ────────────────────────────────────────

  const ws = new WsClient(`/ws/display?sessionId=${sessionId}`);

  ws.on('session:state', (data) => {
    if (data.quiz) {
      document.getElementById('d-quiz-title').textContent = data.quiz.title;
    }
  });

  ws.on('participant:count', (data) => {
    document.getElementById('d-lobby-count').textContent = data.online;
    document.getElementById('d-total').textContent = data.total;
  });

  ws.on('session:started', () => {
    // Stay on lobby until first question
  });

  ws.on('block:started', (data) => {
    document.getElementById('d-q-block').textContent = data.blockTitle || '';
  });

  ws.on('question:show', (data) => {
    showQuestion(data);
  });

  ws.on('stats:live', (data) => {
    document.getElementById('d-answered').textContent = data.totalAnswered;
    document.getElementById('d-total').textContent = data.totalParticipants;
    lastDistribution = data.distribution;

    // Update option counts on question screen (if visible)
    updateOptionCounts(data.distribution, data.totalParticipants);
  });

  ws.on('question:lock', () => {
    clearTimer();
    document.getElementById('d-timer').textContent = '0';
    document.getElementById('d-timer').className = 'd-timer-num critical';
  });

  ws.on('question:reveal', (data) => {
    clearTimer();
    showReveal(data);
  });

  ws.on('question:next', () => {
    // Back to waiting state but keep the same screen briefly
    lastDistribution = {};
    showScreen('d-lobby');
  });

  ws.on('block:end', (data) => {
    document.getElementById('d-block-score').textContent = data.avgScore;
    document.getElementById('d-block-end-title').textContent = data.blockTitle || 'Блок завершён';
    document.getElementById('d-block-end-detail').textContent =
      `${data.participantCount} участников, ${data.totalQuestions} вопросов`;
    showScreen('d-block-end');
  });

  ws.on('session:ended', () => {
    clearTimer();
    showScreen('d-finished');
    ws.close();
  });

  // ── Show Question ────────────────────────────────────

  function showQuestion(data) {
    currentQuestion = data;
    lastDistribution = {};

    document.getElementById('d-q-counter').textContent =
      data.questionNumber && data.totalQuestions
        ? `Вопрос ${data.questionNumber} из ${data.totalQuestions}`
        : '';
    document.getElementById('d-q-block').textContent = data.blockTitle || '';
    document.getElementById('d-q-text').textContent = data.text;
    document.getElementById('d-answered').textContent = '0';

    // Build options
    const optionsEl = document.getElementById('d-options');
    optionsEl.innerHTML = '';

    if (data.type === 'choice' || data.type === 'multi') {
      data.options.forEach((opt, i) => {
        const div = document.createElement('div');
        div.className = 'd-option';
        div.dataset.value = opt;
        div.innerHTML = `
          <span class="d-option-letter">${letters[i] || i + 1}</span>
          <span class="d-option-text">${escapeHtml(opt)}</span>
        `;
        optionsEl.appendChild(div);
      });
      optionsEl.style.display = '';
    } else if (data.type === 'text') {
      optionsEl.innerHTML = `
        <div class="d-option" style="grid-column:1/-1;justify-content:center">
          <span class="d-option-text" style="color:#8fa0a7">Участники вводят текст...</span>
        </div>
      `;
    } else if (data.type === 'scale') {
      optionsEl.innerHTML = `
        <div class="d-option" style="grid-column:1/-1;justify-content:center">
          <span class="d-option-text" style="color:#8fa0a7">Шкала ${data.options[0]} — ${data.options[data.options.length - 1]}</span>
        </div>
      `;
    }

    startTimer(data.timeLimit || 60);
    showScreen('d-question');
  }

  // ── Update Option Counts (live) ──────────────────────

  function updateOptionCounts(distribution) {
    const optionEls = document.querySelectorAll('#d-options .d-option');
    optionEls.forEach((el) => {
      const val = el.dataset.value;
      if (val && distribution[val]) {
        // Remove existing count if any
        let countEl = el.querySelector('.d-option-count');
        if (!countEl) {
          countEl = document.createElement('span');
          countEl.className = 'd-option-count';
          countEl.style.cssText = 'margin-left:auto;font-family:var(--mono);font-size:20px;font-weight:700;color:var(--accent)';
          el.appendChild(countEl);
        }
        countEl.textContent = distribution[val];
      }
    });
  }

  // ── Show Reveal ──────────────────────────────────────

  function showReveal(data) {
    const correctAnswer = data.correctAnswer;
    const distribution = data.distribution || lastDistribution;

    // Question text
    document.getElementById('d-reveal-q-text').textContent =
      currentQuestion ? currentQuestion.text : '';

    // Build histogram
    const histEl = document.getElementById('d-histogram');
    histEl.innerHTML = '';

    const entries = Object.entries(distribution);
    const maxCount = Math.max(...entries.map(([, v]) => v), 1);

    entries.forEach(([label, count]) => {
      const pct = Math.round((count / maxCount) * 100);
      const isCorrect = Array.isArray(correctAnswer)
        ? correctAnswer.includes(label)
        : label === correctAnswer;

      const row = document.createElement('div');
      row.className = 'd-hist-row';
      row.innerHTML = `
        <div class="d-hist-label">${escapeHtml(label)}</div>
        <div class="d-hist-bar-bg">
          <div class="d-hist-bar ${isCorrect ? 'correct' : 'wrong'}" style="width:0%">
            ${count > 0 ? `<span class="d-hist-count">${count}</span>` : ''}
          </div>
        </div>
        <div class="d-hist-count-outside">${count}</div>
      `;
      histEl.appendChild(row);

      // Animate bar width
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          row.querySelector('.d-hist-bar').style.width = `${pct}%`;
        });
      });
    });

    // Explanation
    if (data.explanation) {
      document.getElementById('d-exp-text').textContent = data.explanation;
      document.getElementById('d-explanation').style.display = '';
    } else {
      document.getElementById('d-explanation').style.display = 'none';
    }

    showScreen('d-reveal');
  }

  // ── Timer ────────────────────────────────────────────

  function startTimer(seconds) {
    clearTimer();
    let remaining = seconds;
    const el = document.getElementById('d-timer');
    el.textContent = remaining;
    el.className = 'd-timer-num';

    timerInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearTimer();
        el.textContent = '0';
        el.className = 'd-timer-num critical';
        return;
      }
      el.textContent = remaining;
      if (remaining <= 5) {
        el.className = 'd-timer-num critical';
      } else if (remaining <= 10) {
        el.className = 'd-timer-num warning';
      }
    }, 1000);
  }

  function clearTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // ── Helpers ──────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
});
