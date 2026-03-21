const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { stmts } = require('../db');

const router = Router();
const PRES_DIR = path.join(__dirname, '..', '..', 'data', 'presentations');

// Ensure directory exists
if (!fs.existsSync(PRES_DIR)) fs.mkdirSync(PRES_DIR, { recursive: true });

// Viewer script: receives element-based scroll sync via postMessage from parent iframe
const VIEWER_SCRIPT = `
<script>
(function() {
  // Force desktop viewport on mobile for correct sync
  if (window.innerWidth < 1024) {
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp) vp.setAttribute('content', 'width=1280');
    else {
      vp = document.createElement('meta');
      vp.name = 'viewport';
      vp.content = 'width=1280';
      document.head.appendChild(vp);
    }
  }

  var isMobile = window.innerWidth < 768;

  window.addEventListener('message', function(e) {
    if (!e.data) return;

    if (e.data.type === 'scroll-sync') {
      // Element-based sync: find element by ID and scroll to it
      var el = e.data.id ? document.getElementById(e.data.id) : null;
      if (el) {
        var elTop = el.offsetTop;
        var elHeight = el.offsetHeight;
        var offset = e.data.offset || 0;
        var targetY = elTop + offset * elHeight - window.innerHeight * 0.3;
        document.documentElement.style.scrollSnapType = 'none';
        window.scrollTo({top: Math.max(0, targetY), behavior: isMobile ? 'auto' : 'smooth'});
        setTimeout(function() { document.documentElement.style.scrollSnapType = ''; }, isMobile ? 100 : 600);
      } else if (typeof e.data.ratio === 'number') {
        // Fallback to ratio if no element ID
        var max = document.documentElement.scrollHeight - window.innerHeight;
        if (max > 0) {
          document.documentElement.style.scrollSnapType = 'none';
          window.scrollTo({top: e.data.ratio * max, behavior: isMobile ? 'auto' : 'smooth'});
          setTimeout(function() { document.documentElement.style.scrollSnapType = ''; }, isMobile ? 100 : 600);
        }
      }
    }
  });
})();
</script>
`;

// Presenter script: detects current element and sends via WebSocket
function makePresenterScript(sessionId) {
  return `
<script src="/js/ws-client.js"></script>
<script>
(function() {
  var ws = new WsClient('/ws/presentation?role=presenter&sessionId=${sessionId}');

  // Badge: viewer count
  var badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;background:rgba(15,26,29,0.85);color:#fff;padding:8px 16px;border-radius:12px;font:600 14px/1.4 system-ui,sans-serif;display:flex;align-items:center;gap:8px;backdrop-filter:blur(8px);';
  var dot = document.createElement('span');
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#4ecb71;display:inline-block;';
  badge.appendChild(dot);
  var text = document.createElement('span');
  text.textContent = '0 зрителей';
  badge.appendChild(text);
  document.body.appendChild(badge);

  ws.on('_connected', function() { dot.style.background = '#4ecb71'; });
  ws.on('_disconnected', function() { dot.style.background = '#ff6b6b'; text.textContent = 'Нет связи'; });
  ws.on('viewer:count', function(p) {
    var n = p.count || 0;
    var word = n === 1 ? 'зритель' : (n >= 2 && n <= 4 ? 'зрителя' : 'зрителей');
    text.textContent = n + ' ' + word;
  });

  // Find nearest element with ID at viewport center
  function getCurrentElement() {
    var centerY = window.scrollY + window.innerHeight * 0.4;
    var candidates = document.querySelectorAll('[id]');
    var best = null, bestDist = Infinity;

    candidates.forEach(function(el) {
      if (!el.id || el.offsetHeight < 50) return;
      var top = el.offsetTop;
      var height = el.offsetHeight;
      var elCenter = top + height / 2;
      var dist = Math.abs(elCenter - centerY);
      if (dist < bestDist) { bestDist = dist; best = el; }
    });

    if (best) {
      var elTop = best.offsetTop;
      var elHeight = best.offsetHeight;
      var offset = elHeight > 0 ? Math.max(0, Math.min(1, (centerY - elTop) / elHeight)) : 0;
      return { id: best.id, offset: Math.round(offset * 1000) / 1000 };
    }
    return null;
  }

  // Send current position
  var lastId = '';
  var lastOffset = -1;
  var scrolling = false;
  var timer = null;

  function sendPosition() {
    var pos = getCurrentElement();
    if (!pos) return;
    // Only send if element changed or offset moved significantly
    if (pos.id !== lastId || Math.abs(pos.offset - lastOffset) > 0.02) {
      lastId = pos.id;
      lastOffset = pos.offset;
      ws.send('slide:sync', pos);
    }
  }

  window.addEventListener('scroll', function() {
    if (!scrolling) { scrolling = true; sendPosition(); }
    clearTimeout(timer);
    timer = setTimeout(function() { sendPosition(); scrolling = false; }, 150);
  }, { passive: true });

  // Throttle during active scroll
  var throttle = null;
  window.addEventListener('scroll', function() {
    if (!throttle) {
      throttle = setInterval(function() {
        if (!scrolling) { clearInterval(throttle); throttle = null; return; }
        sendPosition();
      }, 120);
    }
  }, { passive: true });
})();
</script>
`;
}

// GET /api/presentations/:id/file — serve HTML with injected script (public, no auth)
// ?presenter=true&sessionId=X → injects sender script (for speaker)
// otherwise → injects receiver script (for participant iframe)
router.get('/:id/file', (req, res) => {
  const pres = stmts.getPresentationById.get(Number(req.params.id));
  if (!pres) return res.status(404).json({ error: 'Presentation not found' });

  const filePath = path.join(PRES_DIR, pres.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  let html = fs.readFileSync(filePath, 'utf8');

  const isPresenter = req.query.presenter === 'true';
  const sessionId = req.query.sessionId;
  const script = (isPresenter && sessionId)
    ? makePresenterScript(sessionId)
    : VIEWER_SCRIPT;

  if (html.includes('</body>')) {
    html = html.replace('</body>', script + '\n</body>');
  } else {
    html += script;
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
  const pres = stmts.getPresentationById.get(result.lastInsertRowid);
  res.status(201).json(pres);
});

// DELETE /api/presentations/:id
router.delete('/:id', (req, res) => {
  const pres = stmts.getPresentationById.get(Number(req.params.id));
  if (!pres) return res.status(404).json({ error: 'Presentation not found' });

  // Delete file
  const filePath = path.join(PRES_DIR, pres.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  stmts.deletePresentation.run(pres.id);
  res.json({ success: true });
});

module.exports = router;
