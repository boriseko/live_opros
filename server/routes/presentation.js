const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { stmts } = require('../db');

const router = Router();
const PRES_DIR = path.join(__dirname, '..', '..', 'data', 'presentations');

// Ensure directory exists
if (!fs.existsSync(PRES_DIR)) fs.mkdirSync(PRES_DIR, { recursive: true });

// ── Injected Scripts ─────────────────────────────────────

function makePresenterScript(sessionId) {
  return `
<script>
(function() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = proto + '//' + location.host + '/ws/presentation?role=presenter&sessionId=${sessionId}';
  var ws, lastKey = '';

  // ── Detect scroll-swap containers from DOM ──
  var swaps = [];
  document.querySelectorAll('[id]').forEach(function(el) {
    if (el.offsetHeight > window.innerHeight * 2) {
      var panels = el.querySelectorAll('[data-panel]');
      if (panels.length > 1) {
        swaps.push({ id: el.id, count: panels.length, el: el });
      }
    }
  });

  // ── Determine current slide or swap panel ──
  function getCurrentState() {
    var y = window.scrollY;
    var vh = window.innerHeight;

    // Check swap containers first
    for (var i = 0; i < swaps.length; i++) {
      var s = swaps[i];
      var top = s.el.offsetTop;
      var range = s.el.offsetHeight - vh;
      if (range <= 0) continue;
      if (y >= top && y < top + range) {
        var progress = (y - top) / range;
        var panel = Math.min(Math.floor(progress * s.count), s.count - 1);
        return { id: s.id, panel: panel };
      }
    }

    // Find nearest .slide
    var best = null, bestDist = Infinity;
    var slides = document.querySelectorAll('.slide[id]');
    for (var j = 0; j < slides.length; j++) {
      var dist = Math.abs(slides[j].offsetTop - y);
      if (dist < bestDist) { bestDist = dist; best = slides[j].id; }
    }
    return best ? { id: best } : null;
  }

  function sendState() {
    var state = getCurrentState();
    if (!state) return;
    var key = state.id + ':' + (state.panel !== undefined ? state.panel : '-');
    if (key === lastKey) return;
    lastKey = key;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'slide:sync', payload: state }));
    }
  }

  // ── Badge ──
  var badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;background:rgba(15,26,29,0.85);color:#fff;padding:8px 16px;border-radius:12px;font:600 14px/1.4 system-ui,sans-serif;display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px);';
  var dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#888;display:inline-block;';
  badge.appendChild(dot);
  var txt = document.createElement('span');
  txt.textContent = 'Подключение...';
  badge.appendChild(txt);
  document.body.appendChild(badge);

  // ── WebSocket ──
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      dot.style.background = '#4ecb71';
      txt.textContent = '0 зрителей';
      sendState();
    };
    ws.onclose = function() {
      dot.style.background = '#ff6b6b';
      txt.textContent = 'Нет связи';
      setTimeout(connect, 2000);
    };
    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'viewer:count') {
          var n = msg.payload.count || 0;
          var w = n === 1 ? 'зритель' : (n >= 2 && n <= 4 ? 'зрителя' : 'зрителей');
          txt.textContent = n + ' ' + w;
        }
      } catch(err) {}
    };
  }
  connect();

  // ── Scroll listener ──
  var scrollTimer = null;
  window.addEventListener('scroll', function() {
    sendState();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(sendState, 150);
  }, { passive: true });
})();
</script>
`;
}

function makeViewerScript(sessionId) {
  return `
<script>
(function() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = proto + '//' + location.host + '/ws/presentation?role=viewer&sessionId=${sessionId}';
  var ws;
  var isIframe = window.self !== window.top;

  // ── Detect scroll-swap containers from DOM ──
  var swapMap = {};
  document.querySelectorAll('[id]').forEach(function(el) {
    if (el.offsetHeight > window.innerHeight * 2) {
      var panels = el.querySelectorAll('[data-panel]');
      if (panels.length > 1) {
        swapMap[el.id] = { count: panels.length, el: el };
      }
    }
  });

  // ── Lock user scroll, disable snap ──
  document.documentElement.style.scrollSnapType = 'none';
  function lock(e) { e.preventDefault(); }
  window.addEventListener('wheel', lock, { passive: false });
  window.addEventListener('touchmove', lock, { passive: false });
  document.addEventListener('keydown', function(e) {
    if ([32,33,34,35,36,37,38,39,40].indexOf(e.keyCode) >= 0) e.preventDefault();
  });

  // ── Apply sync state ──
  function applyState(state) {
    if (!state || !state.id) return;

    if (state.panel !== undefined && swapMap[state.id]) {
      // Scroll-swap: calculate position for specific panel
      var s = swapMap[state.id];
      var top = s.el.offsetTop;
      var range = s.el.offsetHeight - window.innerHeight;
      if (range <= 0) return;
      var targetY = top + ((state.panel + 0.5) / s.count) * range;
      window.scrollTo({ top: targetY, behavior: 'smooth' });
    } else {
      // Regular slide: scroll to element
      var el = document.getElementById(state.id);
      if (el) window.scrollTo({ top: el.offsetTop, behavior: 'smooth' });
    }
  }

  // ── Badge (skip in iframe) ──
  var dot, txt;
  if (!isIframe) {
    var badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;background:rgba(15,26,29,0.85);color:#fff;padding:8px 16px;border-radius:12px;font:600 14px/1.4 system-ui,sans-serif;display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px);';
    dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#888;display:inline-block;';
    badge.appendChild(dot);
    txt = document.createElement('span');
    txt.textContent = 'Подключение...';
    badge.appendChild(txt);
    document.body.appendChild(badge);
  }

  // ── WebSocket ──
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      if (dot) { dot.style.background = '#4ecb71'; txt.textContent = 'Синхронизация'; }
    };
    ws.onclose = function() {
      if (dot) { dot.style.background = '#ff6b6b'; txt.textContent = 'Переподключение...'; }
      setTimeout(connect, 2000);
    };
    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'slide:sync') applyState(msg.payload);
      } catch(err) {}
    };
  }
  connect();
})();
</script>
`;
}

// GET /api/presentations/:id/file — serve HTML with injected sync script (public)
// ?presenter=true&s=X  → presenter mode (sends scroll)
// ?s=X                 → viewer mode (receives scroll)
// no session param     → raw HTML, no sync
router.get('/:id/file', (req, res) => {
  const pres = stmts.getPresentationById.get(Number(req.params.id));
  if (!pres) return res.status(404).json({ error: 'Presentation not found' });

  const filePath = path.join(PRES_DIR, pres.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  let html = fs.readFileSync(filePath, 'utf8');

  const sessionId = req.query.s || req.query.sessionId;
  if (sessionId) {
    const isPresenter = req.query.presenter === 'true';
    const script = isPresenter
      ? makePresenterScript(Number(sessionId))
      : makeViewerScript(Number(sessionId));

    if (html.includes('</body>')) {
      html = html.replace('</body>', script + '\n</body>');
    } else {
      html += script;
    }
  }

  res.type('html').send(html);
});

// All routes below require auth
router.use(requireAuth);

// GET /api/presentations — list all
router.get('/', (req, res) => {
  const presentations = stmts.getPresentations.all();
  res.json(presentations);
});

// POST /api/presentations — upload (JSON body with HTML content)
router.post('/', (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required' });
  }

  const filename = `${Date.now()}.html`;
  const filePath = path.join(PRES_DIR, filename);
  const fileSize = Buffer.byteLength(content, 'utf8');

  fs.writeFileSync(filePath, content, 'utf8');

  const result = stmts.insertPresentation.run(title, filename, fileSize);
  const newPres = stmts.getPresentationById.get(result.lastInsertRowid);
  res.status(201).json(newPres);
});

// DELETE /api/presentations/:id
router.delete('/:id', (req, res) => {
  const pres = stmts.getPresentationById.get(Number(req.params.id));
  if (!pres) return res.status(404).json({ error: 'Presentation not found' });

  const filePath = path.join(PRES_DIR, pres.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  stmts.deletePresentation.run(pres.id);
  res.json({ success: true });
});

module.exports = router;
