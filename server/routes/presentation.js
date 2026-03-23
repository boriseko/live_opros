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
  var SESSION_ID = ${sessionId};
  var THROTTLE = 100;
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = proto + '//' + location.host + '/ws/presentation?role=presenter&sessionId=' + SESSION_ID;
  var ws, lastSent = 0, scrollTimer = null;

  // Badge
  var badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;background:rgba(15,26,29,0.85);color:#fff;padding:8px 16px;border-radius:12px;font:600 14px/1.4 system-ui,sans-serif;display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px);';
  var dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#888;display:inline-block;';
  badge.appendChild(dot);
  var text = document.createElement('span');
  text.textContent = 'Подключение...';
  badge.appendChild(text);
  document.body.appendChild(badge);

  function sendRatio() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var ratio = max > 0 ? Math.round((window.scrollY / max) * 10000) / 10000 : 0;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'slide:sync', payload: { ratio: ratio } }));
    }
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      dot.style.background = '#4ecb71';
      text.textContent = '0 зрителей';
      sendRatio(); // send initial position
    };
    ws.onclose = function() {
      dot.style.background = '#ff6b6b';
      text.textContent = 'Нет связи';
      setTimeout(connect, 2000);
    };
    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'viewer:count') {
          var n = msg.payload.count || 0;
          var word = n === 1 ? 'зритель' : (n >= 2 && n <= 4 ? 'зрителя' : 'зрителей');
          text.textContent = n + ' ' + word;
        }
      } catch(err) {}
    };
  }

  connect();

  // Scroll listener: throttled + final position on scroll end
  window.addEventListener('scroll', function() {
    var now = Date.now();
    if (now - lastSent >= THROTTLE) {
      lastSent = now;
      sendRatio();
    }
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function() {
      lastSent = Date.now();
      sendRatio();
    }, 150);
  }, { passive: true });
})();
</script>
`;
}

function makeViewerScript(sessionId) {
  return `
<script>
(function() {
  var SESSION_ID = ${sessionId};
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = proto + '//' + location.host + '/ws/presentation?role=viewer&sessionId=' + SESSION_ID;
  var ws;
  var isIframe = window.self !== window.top;

  // Disable scroll-snap and lock user scroll
  document.documentElement.style.scrollSnapType = 'none';
  function preventScroll(e) { e.preventDefault(); }
  window.addEventListener('wheel', preventScroll, { passive: false });
  window.addEventListener('touchmove', preventScroll, { passive: false });
  document.addEventListener('keydown', function(e) {
    if ([32,33,34,35,36,37,38,39,40].indexOf(e.keyCode) >= 0) e.preventDefault();
  });

  // Badge (skip if in iframe)
  var dot, text;
  if (!isIframe) {
    var badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;background:rgba(15,26,29,0.85);color:#fff;padding:8px 16px;border-radius:12px;font:600 14px/1.4 system-ui,sans-serif;display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px);';
    dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#888;display:inline-block;';
    badge.appendChild(dot);
    text = document.createElement('span');
    text.textContent = 'Подключение...';
    badge.appendChild(text);
    document.body.appendChild(badge);
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      if (dot) { dot.style.background = '#4ecb71'; text.textContent = 'Синхронизация'; }
    };
    ws.onclose = function() {
      if (dot) { dot.style.background = '#ff6b6b'; text.textContent = 'Переподключение...'; }
      setTimeout(connect, 2000);
    };
    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'slide:sync') {
          var max = document.documentElement.scrollHeight - window.innerHeight;
          if (max > 0) {
            window.scrollTo({ top: msg.payload.ratio * max, behavior: 'smooth' });
          }
        }
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
