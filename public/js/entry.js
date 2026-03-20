(function () {
  var roleScreen = document.getElementById('screen-role');
  var sessionsScreen = document.getElementById('screen-sessions');
  var sessionsList = document.getElementById('sessions-list');
  var sessionsEmpty = document.getElementById('sessions-empty');

  function showScreen(id) {
    document.querySelectorAll('.entry-screen').forEach(function (s) {
      s.classList.toggle('active', s.id === id);
    });
  }

  // Participant button — show sessions
  document.getElementById('btn-participant').addEventListener('click', function () {
    showScreen('screen-sessions');
    loadSessions();
  });

  // Back button
  document.getElementById('btn-back').addEventListener('click', function () {
    showScreen('screen-role');
  });

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function loadSessions() {
    sessionsList.innerHTML = '<div class="sessions-loading">Загрузка...</div>';
    sessionsEmpty.style.display = 'none';

    fetch('/api/sessions/active')
      .then(function (r) { return r.json(); })
      .then(function (sessions) {
        if (!sessions.length) {
          sessionsList.innerHTML = '';
          sessionsEmpty.style.display = '';
          return;
        }

        sessionsEmpty.style.display = 'none';
        sessionsList.innerHTML = sessions.map(function (s) {
          var url = s.presentation_id
            ? '/training.html?s=' + s.id
            : '/index.html?s=' + s.id;
          var statusText = s.status === 'waiting' ? 'Ожидание' : 'Идёт';
          var presLabel = s.presentation_title ? ' + ' + esc(s.presentation_title) : '';

          return '<a href="' + url + '" class="session-card">' +
            '<div class="session-card-info">' +
              '<div class="session-card-title">' + esc(s.quiz_title) + presLabel + '</div>' +
              '<div class="session-card-meta">' +
                '<span>' + statusText + '</span>' +
                '<span>' + s.participant_count + ' уч.</span>' +
              '</div>' +
            '</div>' +
            '<div class="session-card-arrow">' +
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<polyline points="9 18 15 12 9 6"/>' +
              '</svg>' +
            '</div>' +
          '</a>';
        }).join('');
      })
      .catch(function () {
        sessionsList.innerHTML = '<div class="sessions-loading" style="color:var(--red)">Ошибка загрузки</div>';
      });
  }
})();
