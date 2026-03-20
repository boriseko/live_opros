/**
 * Presentation sync client.
 * Presenter mode: sends slide position to server.
 * Viewer mode: receives position and auto-scrolls.
 *
 * Requires: ws-client.js (WsClient class) loaded before this script.
 * Requires: navStops[] and navigateTo() from the landing page JS.
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var mode = params.get('mode'); // 'presenter' or null (viewer)
  var isPresenter = mode === 'presenter';
  var role = isPresenter ? 'presenter' : 'viewer';

  // Connect to presentation WebSocket
  var ws = new WsClient('/ws/presentation?role=' + role);

  // ─── UI: viewer count badge (presenter) / sync indicator (viewer) ───

  var badge = document.createElement('div');
  badge.id = 'sync-badge';
  badge.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:99999;' +
    'background:rgba(15,26,29,0.85);color:#fff;padding:8px 16px;' +
    'border-radius:12px;font:600 14px/1.4 system-ui,sans-serif;' +
    'display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px);' +
    'transition:opacity 0.3s;pointer-events:auto;';
  document.body.appendChild(badge);

  // Connection status dot
  var dot = document.createElement('span');
  dot.style.cssText =
    'width:8px;height:8px;border-radius:50%;background:#4ecb71;' +
    'display:inline-block;flex-shrink:0;';
  badge.appendChild(dot);

  var badgeText = document.createElement('span');
  badge.appendChild(badgeText);

  ws.on('_connected', function () {
    dot.style.background = '#4ecb71';
  });
  ws.on('_disconnected', function () {
    dot.style.background = '#ff6b6b';
    badgeText.textContent = isPresenter ? 'Нет связи' : 'Переподключение...';
  });

  // ─── PRESENTER MODE ─────────────────────────────────────

  if (isPresenter) {
    badgeText.textContent = '0 зрителей';

    ws.on('viewer:count', function (p) {
      var n = p.count || 0;
      var word = n === 1 ? 'зритель' : (n >= 2 && n <= 4 ? 'зрителя' : 'зрителей');
      badgeText.textContent = n + ' ' + word;
    });

    // Intercept navigateTo: after each navigation, send the stop index
    var _origNavigateTo = window.navigateTo;
    if (typeof _origNavigateTo !== 'function') {
      // navigateTo is inside an IIFE — we need another approach.
      // Hook into scroll events instead, debounced.
    }

    // Since navigateTo is inside an IIFE and not global, we track via scroll.
    // After each scroll settles, find the closest navStop and send it.
    var lastSentIndex = -1;
    var scrollTimer = null;

    function sendCurrentStop() {
      if (typeof navStops === 'undefined' || !navStops.length) return;
      var cur = Math.round(window.scrollY);
      var bestIdx = 0, bestDist = Infinity;
      for (var i = 0; i < navStops.length; i++) {
        var dist = Math.abs(navStops[i] - cur);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      if (bestIdx !== lastSentIndex) {
        lastSentIndex = bestIdx;
        ws.send('slide:sync', { stopIndex: bestIdx });
      }
    }

    window.addEventListener('scroll', function () {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(sendCurrentStop, 300);
    }, { passive: true });

    // Quiz time button
    var quizBtn = document.createElement('button');
    quizBtn.textContent = 'Опрос!';
    quizBtn.style.cssText =
      'position:fixed;top:16px;right:200px;z-index:99999;' +
      'background:linear-gradient(135deg,#58ccbb,#3bb8a5);color:#fff;' +
      'border:none;padding:8px 20px;border-radius:12px;cursor:pointer;' +
      'font:700 14px/1.4 system-ui,sans-serif;backdrop-filter:blur(8px);' +
      'transition:transform 0.15s;';
    quizBtn.addEventListener('mouseenter', function () { quizBtn.style.transform = 'scale(1.05)'; });
    quizBtn.addEventListener('mouseleave', function () { quizBtn.style.transform = ''; });
    quizBtn.addEventListener('click', function () {
      ws.send('slide:quiztime', {});
      quizBtn.textContent = 'Отправлено!';
      quizBtn.style.background = 'rgba(15,26,29,0.85)';
      setTimeout(function () {
        quizBtn.textContent = 'Опрос!';
        quizBtn.style.background = 'linear-gradient(135deg,#58ccbb,#3bb8a5)';
      }, 3000);
    });
    document.body.appendChild(quizBtn);

    return; // Presenter setup done
  }

  // ─── VIEWER MODE ────────────────────────────────────────

  badgeText.textContent = 'Синхронизация';

  ws.on('viewer:count', function (p) {
    // Viewer doesn't need to show count
  });

  // Disable keyboard navigation for viewers (presenter controls)
  document.addEventListener('keydown', function (e) {
    var keys = ['PageDown', 'PageUp', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'];
    if (keys.indexOf(e.key) !== -1 || (e.key === ' ' && !e.target.isContentEditable)) {
      e.stopImmediatePropagation();
    }
  }, true); // capture phase — fires before the landing's listener

  // Auto-scroll on sync events
  ws.on('slide:sync', function (p) {
    var idx = p.stopIndex;
    if (typeof navStops === 'undefined' || !navStops.length) return;
    // Clamp to valid range
    if (idx < 0) idx = 0;
    if (idx >= navStops.length) idx = navStops.length - 1;

    // Disable snap during sync scroll
    document.documentElement.style.scrollSnapType = 'none';
    window.scrollTo({ top: navStops[idx], behavior: 'smooth' });
    setTimeout(function () {
      document.documentElement.style.scrollSnapType = '';
    }, 700);
  });

  // Quiz time notification
  ws.on('slide:quiztime', function () {
    // Show overlay notification
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(15,26,29,0.7);backdrop-filter:blur(6px);' +
      'animation:fadeIn 0.3s ease;';

    var card = document.createElement('div');
    card.style.cssText =
      'background:#fff;border-radius:20px;padding:40px 48px;text-align:center;' +
      'max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,0.3);';

    card.innerHTML =
      '<div style="font-size:48px;margin-bottom:16px;">&#9997;&#65039;</div>' +
      '<div style="font:800 24px/1.3 system-ui,sans-serif;color:#0f1a1d;margin-bottom:8px;">Время опроса!</div>' +
      '<div style="font:400 16px/1.5 system-ui,sans-serif;color:#6b7f86;margin-bottom:24px;">Нажмите кнопку чтобы открыть опрос</div>' +
      '<a href="/index.html" target="_blank" rel="noopener" style="' +
        'display:inline-block;background:linear-gradient(135deg,#58ccbb,#3bb8a5);' +
        'color:#fff;text-decoration:none;padding:14px 36px;border-radius:14px;' +
        'font:700 18px/1.4 system-ui,sans-serif;' +
      '">Открыть опрос</a>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Close on click outside the card
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    // Auto-close after 30 seconds
    setTimeout(function () {
      if (overlay.parentNode) overlay.remove();
    }, 30000);
  });

  // Add fadeIn keyframes
  var style = document.createElement('style');
  style.textContent = '@keyframes fadeIn{from{opacity:0}to{opacity:1}}';
  document.head.appendChild(style);
})();
