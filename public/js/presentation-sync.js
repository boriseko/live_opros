/**
 * Presentation sync client.
 * Presenter mode: sends scroll ratio to server.
 * Viewer mode: receives ratio and auto-scrolls.
 *
 * Uses scroll RATIO (0.0–1.0) instead of stop indices,
 * so it works smoothly for scroll-swap panels and any position.
 *
 * Requires: ws-client.js (WsClient class) loaded before this script.
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var mode = params.get('mode'); // 'presenter' or null (viewer)
  var isPresenter = mode === 'presenter';
  var role = isPresenter ? 'presenter' : 'viewer';

  // Connect to presentation WebSocket
  var ws = new WsClient('/ws/presentation?role=' + role);

  // ─── Helpers ────────────────────────────────────────────

  function getMaxScroll() {
    return document.documentElement.scrollHeight - window.innerHeight;
  }

  function getScrollRatio() {
    var max = getMaxScroll();
    return max > 0 ? window.scrollY / max : 0;
  }

  // ─── UI: badge ──────────────────────────────────────────

  var badge = document.createElement('div');
  badge.id = 'sync-badge';
  badge.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:99999;' +
    'background:rgba(15,26,29,0.85);color:#fff;padding:8px 16px;' +
    'border-radius:12px;font:600 14px/1.4 system-ui,sans-serif;' +
    'display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px);' +
    'transition:opacity 0.3s;pointer-events:auto;';
  document.body.appendChild(badge);

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

    // Send scroll ratio — throttled (every 100ms during active scroll)
    var lastSentRatio = -1;
    var scrollThrottleTimer = null;
    var isScrolling = false;

    function sendScrollPosition() {
      var ratio = Math.round(getScrollRatio() * 10000) / 10000; // 4 decimal places
      if (ratio !== lastSentRatio) {
        lastSentRatio = ratio;
        ws.send('slide:sync', { ratio: ratio });
      }
    }

    window.addEventListener('scroll', function () {
      if (!isScrolling) {
        isScrolling = true;
        sendScrollPosition(); // Send immediately on scroll start
      }
      clearTimeout(scrollThrottleTimer);
      scrollThrottleTimer = setTimeout(function () {
        sendScrollPosition(); // Send on scroll end
        isScrolling = false;
      }, 150);
    }, { passive: true });

    // Also send periodically during scroll (throttle)
    var throttleInterval = null;
    window.addEventListener('scroll', function () {
      if (!throttleInterval) {
        throttleInterval = setInterval(function () {
          if (!isScrolling) {
            clearInterval(throttleInterval);
            throttleInterval = null;
            return;
          }
          sendScrollPosition();
        }, 100);
      }
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

  // Disable keyboard navigation for viewers (presenter controls)
  document.addEventListener('keydown', function (e) {
    var keys = ['PageDown', 'PageUp', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'];
    if (keys.indexOf(e.key) !== -1 || (e.key === ' ' && !e.target.isContentEditable)) {
      e.stopImmediatePropagation();
    }
  }, true); // capture phase — fires before the landing's listener

  // Auto-scroll on sync events
  var syncScrolling = false;

  ws.on('slide:sync', function (p) {
    var ratio = p.ratio;
    if (typeof ratio !== 'number') return;

    var max = getMaxScroll();
    var targetY = Math.round(ratio * max);

    // Disable snap during sync
    document.documentElement.style.scrollSnapType = 'none';
    syncScrolling = true;

    window.scrollTo({ top: targetY, behavior: 'smooth' });

    // Re-enable snap after scroll settles
    clearTimeout(syncScrolling._timer);
    syncScrolling._timer = setTimeout(function () {
      document.documentElement.style.scrollSnapType = '';
      syncScrolling = false;
    }, 600);
  });

  // Quiz time notification
  ws.on('slide:quiztime', function () {
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

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    setTimeout(function () {
      if (overlay.parentNode) overlay.remove();
    }, 30000);
  });

  var style = document.createElement('style');
  style.textContent = '@keyframes fadeIn{from{opacity:0}to{opacity:1}}';
  document.head.appendChild(style);
})();
