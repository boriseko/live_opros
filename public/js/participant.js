document.addEventListener('DOMContentLoaded', () => {
  // ── State ────────────────────────────────────────────

  let ws = null;
  let participantId = null;
  let participantName = '';
  let sessionId = null;
  let timerInterval = null;
  let currentQuestion = null;
  let selectedAnswers = []; // For multi-select

  // ── DOM ──────────────────────────────────────────────

  const screens = document.querySelectorAll('.screen');
  const connDot = document.getElementById('conn-dot');
  const connText = document.getElementById('conn-text');

  function showScreen(id) {
    screens.forEach((s) => s.classList.remove('active'));
    document.getElementById(`screen-${id}`).classList.add('active');
  }

  // ── Session ID from URL ──────────────────────────────

  const urlParams = new URLSearchParams(window.location.search);
  sessionId = Number(urlParams.get('s') || urlParams.get('session'));

  if (!sessionId) {
    // Try to get from localStorage (reconnect)
    sessionId = Number(localStorage.getItem('lo_sessionId'));
  }

  if (!sessionId) {
    // No session — show error or default to latest session
    document.querySelector('.join-subtitle').textContent = 'Сессия не найдена. Попросите ссылку у ведущего.';
    document.getElementById('join-btn').disabled = true;
    return;
  }

  localStorage.setItem('lo_sessionId', sessionId);

  // ── Check for reconnect ──────────────────────────────

  const savedPId = localStorage.getItem(`lo_pid_${sessionId}`);
  const savedName = localStorage.getItem(`lo_name_${sessionId}`);

  // ── Join Form ────────────────────────────────────────

  const joinForm = document.getElementById('join-form');
  const nameInput = document.getElementById('name-input');

  if (savedName) {
    nameInput.value = savedName;
  }

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;

    participantName = name;
    localStorage.setItem(`lo_name_${sessionId}`, name);

    connectWs(name);
  });

  // ── WebSocket Connection ─────────────────────────────

  function connectWs(name) {
    const joinPayload = { name };
    if (savedPId) {
      joinPayload.participantId = Number(savedPId);
    }

    ws = new WsClient(`/ws/participant?sessionId=${sessionId}`);

    ws.on('_connected', () => {
      connDot.classList.remove('offline');
      connText.textContent = 'Подключено';
      ws.send('participant:join', joinPayload);
    });

    ws.on('_disconnected', () => {
      connDot.classList.add('offline');
      connText.textContent = 'Переподключение...';
      clearTimer();
    });

    ws.on('participant:joined', (data) => {
      participantId = data.participantId;
      participantName = data.name;
      localStorage.setItem(`lo_pid_${sessionId}`, participantId);
      showScreen('waiting');
      document.getElementById('name-badge').textContent = participantName;
    });

    ws.on('session:waiting', (data) => {
      showScreen('waiting');
      if (data.quizTitle) {
        document.querySelector('.waiting-text').textContent = data.quizTitle;
      }
    });

    ws.on('session:started', () => {
      showScreen('waiting');
      document.querySelector('.waiting-text').textContent = 'Сессия начата! Ожидание вопроса...';
    });

    ws.on('participant:count', (data) => {
      document.getElementById('waiting-count').textContent =
        `Участников: ${data.online} из ${data.total}`;
    });

    ws.on('question:show', (data) => {
      showQuestion(data);
    });

    ws.on('answer:accepted', () => {
      clearTimer();
      showScreen('answered');
    });

    ws.on('answer:already_submitted', () => {
      clearTimer();
      showScreen('answered');
    });

    ws.on('question:lock', () => {
      clearTimer();
      // If still on question screen (didn't answer), show answered with "Время вышло"
      if (document.getElementById('screen-question').classList.contains('active')) {
        showScreen('answered');
        document.querySelector('#screen-answered h2').textContent = 'Время вышло';
      }
    });

    ws.on('question:reveal', (data) => {
      showReveal(data);
    });

    ws.on('question:next', () => {
      showScreen('waiting');
      document.querySelector('.waiting-text').textContent = 'Следующий вопрос...';
    });

    ws.on('block:started', () => {
      showScreen('waiting');
      document.querySelector('.waiting-text').textContent = 'Новый блок! Ожидание вопроса...';
    });

    ws.on('block:end', (data) => {
      showBlockEnd(data);
    });

    ws.on('session:ended', () => {
      showScreen('finished');
      clearTimer();
      if (ws) ws.close();
    });

    ws.on('error', (data) => {
      console.error('Server error:', data.message);
    });
  }

  // ── Show Question ────────────────────────────────────

  function showQuestion(data) {
    currentQuestion = data;
    selectedAnswers = [];

    // Reset answered screen text
    document.querySelector('#screen-answered h2').textContent = 'Ответ принят!';

    // Counter
    const counter = document.getElementById('q-counter');
    if (data.questionNumber && data.totalQuestions) {
      counter.textContent = `${data.questionNumber} / ${data.totalQuestions}`;
    } else {
      counter.textContent = data.blockTitle || '';
    }

    // Question text
    document.getElementById('q-text').textContent = data.text;

    // Options container
    const optionsEl = document.getElementById('q-options');
    optionsEl.innerHTML = '';

    const letters = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'];

    if (data.type === 'choice') {
      const list = document.createElement('div');
      list.className = 'options-list';
      data.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.innerHTML = `
          <span class="option-letter">${letters[i] || i + 1}</span>
          <span class="option-text">${escapeHtml(opt)}</span>
        `;
        btn.addEventListener('click', () => {
          ws.send('answer:submit', { questionId: data.questionId, answer: opt });
          // Highlight selected
          list.querySelectorAll('.option-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          disableOptions(list);
        });
        list.appendChild(btn);
      });
      optionsEl.appendChild(list);

    } else if (data.type === 'multi') {
      const list = document.createElement('div');
      list.className = 'options-list';
      data.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.innerHTML = `
          <span class="checkbox"></span>
          <span class="option-text">${escapeHtml(opt)}</span>
        `;
        btn.addEventListener('click', () => {
          btn.classList.toggle('selected');
          if (btn.classList.contains('selected')) {
            selectedAnswers.push(opt);
          } else {
            selectedAnswers = selectedAnswers.filter((a) => a !== opt);
          }
        });
        list.appendChild(btn);
      });

      const submitBtn = document.createElement('button');
      submitBtn.className = 'btn btn-accent btn-lg btn-block mt-md';
      submitBtn.textContent = 'Отправить';
      submitBtn.addEventListener('click', () => {
        if (selectedAnswers.length === 0) return;
        ws.send('answer:submit', { questionId: data.questionId, answer: selectedAnswers });
        disableOptions(list);
        submitBtn.disabled = true;
      });

      optionsEl.appendChild(list);
      optionsEl.appendChild(submitBtn);

    } else if (data.type === 'text') {
      const form = document.createElement('div');
      form.className = 'text-answer-form';
      form.innerHTML = `
        <textarea class="textarea" id="text-answer" placeholder="Введите ваш ответ..." rows="4"></textarea>
        <button class="btn btn-accent btn-lg btn-block" id="text-submit">Отправить</button>
      `;
      optionsEl.appendChild(form);

      form.querySelector('#text-submit').addEventListener('click', () => {
        const answer = form.querySelector('#text-answer').value.trim();
        if (!answer) return;
        ws.send('answer:submit', { questionId: data.questionId, answer });
        form.querySelector('#text-submit').disabled = true;
        form.querySelector('#text-answer').disabled = true;
      });

    } else if (data.type === 'scale') {
      const container = document.createElement('div');
      container.className = 'scale-options';
      data.options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.className = 'scale-btn';
        btn.textContent = opt;
        btn.addEventListener('click', () => {
          ws.send('answer:submit', { questionId: data.questionId, answer: opt });
          container.querySelectorAll('.scale-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          disableScale(container);
        });
        container.appendChild(btn);
      });
      optionsEl.appendChild(container);
    }

    // Timer
    startTimer(data.timeLimit || 60);
    showScreen('question');
  }

  function disableOptions(list) {
    list.querySelectorAll('.option-btn').forEach((btn) => {
      btn.style.pointerEvents = 'none';
    });
  }

  function disableScale(container) {
    container.querySelectorAll('.scale-btn').forEach((btn) => {
      btn.style.pointerEvents = 'none';
    });
  }

  // ── Timer ────────────────────────────────────────────

  function startTimer(seconds) {
    clearTimer();
    let remaining = seconds;
    const timerEl = document.getElementById('q-timer');
    timerEl.textContent = remaining;
    timerEl.className = 'question-timer-text';

    timerInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearTimer();
        timerEl.textContent = '0';
        return;
      }
      timerEl.textContent = remaining;

      if (remaining <= 5) {
        timerEl.className = 'question-timer-text critical';
      } else if (remaining <= 10) {
        timerEl.className = 'question-timer-text warning';
      }
    }, 1000);
  }

  function clearTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // ── Show Reveal ──────────────────────────────────────

  function showReveal(data) {
    clearTimer();
    const result = document.getElementById('reveal-result');
    const icon = document.getElementById('reveal-icon');
    const text = document.getElementById('reveal-text');
    const answer = document.getElementById('reveal-answer');
    const explanation = document.getElementById('reveal-explanation-text');

    result.className = 'reveal-result';

    if (data.isCorrect === true) {
      result.classList.add('correct');
      icon.textContent = '\u2705';
      text.textContent = 'Правильно!';
      // Don't show the correct answer — they already know it
      answer.classList.add('hidden');
    } else if (data.isCorrect === false) {
      result.classList.add('incorrect');
      icon.textContent = '\u274C';
      text.textContent = 'Неправильно';
      // Show correct answer so they learn
      if (data.correctAnswer) {
        const correct = Array.isArray(data.correctAnswer)
          ? data.correctAnswer.join(', ')
          : data.correctAnswer;
        answer.textContent = `Правильный ответ: ${correct}`;
        answer.classList.remove('hidden');
      } else {
        answer.classList.add('hidden');
      }
    } else {
      // text/scale — no correct answer
      result.classList.add('neutral');
      icon.textContent = '\u2705';
      text.textContent = 'Ответ принят';
      answer.classList.add('hidden');
    }

    if (data.explanation) {
      explanation.textContent = data.explanation;
      document.getElementById('reveal-explanation').classList.remove('hidden');
    } else {
      document.getElementById('reveal-explanation').classList.add('hidden');
    }

    showScreen('reveal');
  }

  // ── Block End ────────────────────────────────────────

  function showBlockEnd(data) {
    document.getElementById('block-end-title').textContent = data.blockTitle || '';
    document.getElementById('block-score').textContent = data.yourScore;
    document.getElementById('block-score-label').textContent = `из ${data.totalQuestions}`;
    showScreen('block-end');
  }

  // ── Helpers ──────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Auto-connect if saved ────────────────────────────

  if (savedPId && savedName) {
    participantName = savedName;
    nameInput.value = savedName;
    connectWs(savedName);
  }
});
