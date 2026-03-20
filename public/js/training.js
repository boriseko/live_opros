/**
 * Training page client.
 * Full-screen presentation (iframe) with quiz question overlays.
 * Connects to /ws/participant — same protocol as participant.js.
 */
(function () {
  // ── State ────────────────────────────────────────────────
  var ws = null;
  var sessionId = null;
  var participantId = null;
  var participantName = '';
  var presentationId = null;
  var currentQuestion = null;
  var selectedAnswers = [];
  var timerInterval = null;

  // ── DOM refs ─────────────────────────────────────────────
  var iframe = document.getElementById('pres-iframe');
  var connDot = document.getElementById('conn-dot');
  var connText = document.getElementById('conn-text');

  // ── Helpers ──────────────────────────────────────────────
  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function showScreen(id) {
    document.querySelectorAll('.training-overlay').forEach(function (s) {
      s.classList.toggle('active', s.id === id);
    });
  }

  function hideAllOverlays() {
    document.querySelectorAll('.training-overlay').forEach(function (s) {
      s.classList.remove('active');
    });
  }

  var LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З'];

  // ── Timer ────────────────────────────────────────────────
  function startTimer(seconds) {
    clearTimer();
    var remaining = seconds;
    var el = document.getElementById('q-timer');
    el.textContent = remaining;
    el.className = 'quiz-timer-text';

    timerInterval = setInterval(function () {
      remaining--;
      if (remaining <= 0) {
        remaining = 0;
        clearTimer();
      }
      el.textContent = remaining;
      if (remaining <= 5) el.className = 'quiz-timer-text critical';
      else if (remaining <= 10) el.className = 'quiz-timer-text warning';
    }, 1000);
  }

  function clearTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  // ── Init: get session from URL ───────────────────────────
  var params = new URLSearchParams(window.location.search);
  sessionId = Number(params.get('s') || params.get('session'));

  if (!sessionId) {
    document.getElementById('join-subtitle').textContent = 'Сессия не найдена';
    document.getElementById('join-btn').disabled = true;
    return;
  }

  // Load session info
  fetch('/api/sessions/' + sessionId + '/public')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) {
        document.getElementById('join-subtitle').textContent = 'Сессия не найдена';
        document.getElementById('join-btn').disabled = true;
        return;
      }
      presentationId = data.presentation_id;
      document.getElementById('join-title').textContent = data.quiz_title || 'Тренинг';
      document.getElementById('join-subtitle').textContent = data.presentation_title || 'Введите имя для участия';

      // Load saved name
      var savedName = localStorage.getItem('lo_name_' + sessionId);
      if (savedName) document.getElementById('name-input').value = savedName;
    })
    .catch(function () {
      document.getElementById('join-subtitle').textContent = 'Ошибка загрузки';
    });

  // ── Join form ────────────────────────────────────────────
  document.getElementById('join-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('name-input').value.trim();
    if (!name) return;
    participantName = name;
    connectWs(name);
  });

  function connectWs(name) {
    var savedPid = localStorage.getItem('lo_pid_' + sessionId);
    ws = new WsClient('/ws/participant?sessionId=' + sessionId);

    ws.on('_connected', function () {
      connDot.classList.remove('offline');
      connText.textContent = 'Подключено';
      ws.send('participant:join', {
        name: name,
        participantId: savedPid ? Number(savedPid) : undefined,
      });
    });

    ws.on('_disconnected', function () {
      connDot.classList.add('offline');
      connText.textContent = 'Переподключение...';
    });

    // ── WS Event Handlers ──────────────────────────────────

    ws.on('participant:joined', function (data) {
      participantId = data.participantId;
      localStorage.setItem('lo_pid_' + sessionId, participantId);
      localStorage.setItem('lo_name_' + sessionId, name);

      // Load presentation in iframe
      if (presentationId) {
        iframe.src = '/api/presentations/' + presentationId + '/file';
      }
      hideAllOverlays(); // Hide join screen, show presentation
    });

    ws.on('error', function (data) {
      document.getElementById('join-subtitle').textContent = data.message || 'Ошибка';
      document.getElementById('join-subtitle').style.color = 'var(--red)';
    });

    // Slide sync
    ws.on('slide:sync', function (data) {
      if (!iframe.contentWindow) return;
      try {
        iframe.contentWindow.postMessage({ type: 'scroll-sync', ratio: data.ratio }, '*');
      } catch (e) { /* cross-origin or not loaded yet */ }
    });

    // Question show
    ws.on('question:show', function (data) {
      currentQuestion = data;
      selectedAnswers = [];
      renderQuestion(data);
      showScreen('screen-question');
      if (data.timeLimit) startTimer(data.timeLimit);
    });

    // Answer accepted
    ws.on('answer:accepted', function () {
      clearTimer();
      document.getElementById('answered-text').textContent = 'Ответ принят!';
      showScreen('screen-answered');
    });

    ws.on('answer:already_submitted', function () {
      clearTimer();
      document.getElementById('answered-text').textContent = 'Ответ уже отправлен';
      showScreen('screen-answered');
    });

    // Question lock (time up)
    ws.on('question:lock', function () {
      clearTimer();
      // If not answered yet, show time-up
      var screen = document.querySelector('.training-overlay.active');
      if (screen && screen.id === 'screen-question') {
        document.getElementById('answered-text').textContent = 'Время вышло';
        showScreen('screen-answered');
      }
    });

    // Reveal
    ws.on('question:reveal', function (data) {
      clearTimer();
      renderReveal(data);
      showScreen('screen-reveal');
    });

    // Next question
    ws.on('question:next', function () {
      clearTimer();
      currentQuestion = null;
      hideAllOverlays(); // Back to presentation
    });

    // Block started
    ws.on('block:started', function () {
      hideAllOverlays();
    });

    // Block end
    ws.on('block:end', function (data) {
      renderBlockEnd(data);
      showScreen('screen-block-end');
      // Auto-close after 5 seconds
      setTimeout(function () {
        var screen = document.querySelector('.training-overlay.active');
        if (screen && screen.id === 'screen-block-end') hideAllOverlays();
      }, 5000);
    });

    // Session ended
    ws.on('session:ended', function () {
      clearTimer();
      showScreen('screen-finished');
      localStorage.removeItem('lo_pid_' + sessionId);
      localStorage.removeItem('lo_name_' + sessionId);
    });

    // Session waiting / started (resync state)
    ws.on('session:waiting', function () { hideAllOverlays(); });
    ws.on('session:started', function () { hideAllOverlays(); });
    ws.on('participant:count', function () { /* ignore in training view */ });
  }

  // ── Render Question ──────────────────────────────────────
  function renderQuestion(data) {
    document.getElementById('q-counter').textContent =
      'Вопрос ' + data.questionNumber + ' из ' + data.totalQuestions;
    document.getElementById('q-text').innerHTML = esc(data.text);

    var optionsEl = document.getElementById('q-options');
    optionsEl.innerHTML = '';

    if (data.type === 'choice') {
      data.options.forEach(function (opt, i) {
        var btn = document.createElement('button');
        btn.className = 'quiz-option-btn';
        btn.innerHTML = '<span class="quiz-option-letter">' + LETTERS[i] + '</span>' +
          '<span>' + esc(opt) + '</span>';
        btn.addEventListener('click', function () {
          optionsEl.querySelectorAll('.quiz-option-btn').forEach(function (b) {
            b.classList.remove('selected');
            b.classList.add('disabled');
          });
          btn.classList.add('selected');
          ws.send('answer:submit', { questionId: data.questionId, answer: opt });
        });
        optionsEl.appendChild(btn);
      });

    } else if (data.type === 'multi') {
      data.options.forEach(function (opt) {
        var btn = document.createElement('button');
        btn.className = 'quiz-option-btn';
        btn.innerHTML = '<span class="quiz-check"></span><span>' + esc(opt) + '</span>';
        btn.addEventListener('click', function () {
          btn.classList.toggle('selected');
          var idx = selectedAnswers.indexOf(opt);
          if (idx >= 0) selectedAnswers.splice(idx, 1);
          else selectedAnswers.push(opt);
        });
        optionsEl.appendChild(btn);
      });

      var submitBtn = document.createElement('button');
      submitBtn.className = 'btn btn-accent btn-lg btn-block quiz-submit-btn';
      submitBtn.textContent = 'Отправить';
      submitBtn.addEventListener('click', function () {
        if (!selectedAnswers.length) return;
        optionsEl.querySelectorAll('.quiz-option-btn').forEach(function (b) { b.classList.add('disabled'); });
        submitBtn.disabled = true;
        ws.send('answer:submit', { questionId: data.questionId, answer: selectedAnswers });
      });
      optionsEl.appendChild(submitBtn);

    } else if (data.type === 'text') {
      var ta = document.createElement('textarea');
      ta.className = 'quiz-textarea';
      ta.placeholder = 'Введите ваш ответ...';
      ta.maxLength = 5000;
      optionsEl.appendChild(ta);

      var submitBtn2 = document.createElement('button');
      submitBtn2.className = 'btn btn-accent btn-lg btn-block quiz-submit-btn';
      submitBtn2.textContent = 'Отправить';
      submitBtn2.addEventListener('click', function () {
        var val = ta.value.trim();
        if (!val) return;
        ta.disabled = true;
        submitBtn2.disabled = true;
        ws.send('answer:submit', { questionId: data.questionId, answer: val });
      });
      optionsEl.appendChild(submitBtn2);

    } else if (data.type === 'scale') {
      var scaleDiv = document.createElement('div');
      scaleDiv.className = 'quiz-scale';
      for (var n = 1; n <= 10; n++) {
        (function (num) {
          var btn = document.createElement('button');
          btn.className = 'quiz-scale-btn';
          btn.textContent = num;
          btn.addEventListener('click', function () {
            scaleDiv.querySelectorAll('.quiz-scale-btn').forEach(function (b) {
              b.classList.remove('selected');
              b.style.pointerEvents = 'none';
            });
            btn.classList.add('selected');
            ws.send('answer:submit', { questionId: data.questionId, answer: String(num) });
          });
          scaleDiv.appendChild(btn);
        })(n);
      }
      optionsEl.appendChild(scaleDiv);
    }
  }

  // ── Render Reveal ────────────────────────────────────────
  function renderReveal(data) {
    var el = document.getElementById('reveal-result');
    var icon, text, cssClass;

    if (data.isCorrect === true) {
      icon = '&#9989;'; text = 'Правильно!'; cssClass = 'correct';
    } else if (data.isCorrect === false) {
      icon = '&#10060;'; text = 'Неправильно'; cssClass = 'incorrect';
    } else {
      icon = '&#9989;'; text = 'Ответ принят'; cssClass = 'neutral';
    }

    var html = '<div class="reveal-card">' +
      '<div class="reveal-icon">' + icon + '</div>' +
      '<div class="reveal-text ' + cssClass + '">' + text + '</div>';

    if (data.isCorrect === false && data.correctAnswer) {
      var ans = Array.isArray(data.correctAnswer) ? data.correctAnswer.join(', ') : data.correctAnswer;
      html += '<div class="reveal-answer">Правильный ответ: ' + esc(ans) + '</div>';
    }

    if (data.explanation) {
      html += '<div class="reveal-explanation">' +
        '<div class="reveal-explanation-label">Пояснение</div>' +
        esc(data.explanation) +
      '</div>';
    }

    html += '</div>';
    el.innerHTML = html;
  }

  // ── Render Block End ─────────────────────────────────────
  function renderBlockEnd(data) {
    var el = document.getElementById('block-end-content');
    el.innerHTML =
      '<div class="block-score-circle">' +
        '<div class="block-score-num">' + data.yourScore + '/' + data.totalQuestions + '</div>' +
        '<div class="block-score-label">верно</div>' +
      '</div>' +
      '<h3 style="font-size:18px;font-weight:700;margin-bottom:4px;">' + esc(data.blockTitle) + '</h3>' +
      '<p style="font-size:14px;color:var(--slate);">Блок завершён</p>';
  }
})();
