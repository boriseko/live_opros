const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { stmts } = require('../db');

const router = Router();
const PRES_DIR = path.join(__dirname, '..', '..', 'data', 'presentations');

// Ensure directory exists
if (!fs.existsSync(PRES_DIR)) fs.mkdirSync(PRES_DIR, { recursive: true });

// Viewer script: receives scroll position via postMessage from parent iframe
const VIEWER_SCRIPT = `
<script>
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'scroll-sync') {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (max > 0) {
      document.documentElement.style.scrollSnapType = 'none';
      window.scrollTo({top: e.data.ratio * max, behavior: 'smooth'});
      setTimeout(function() { document.documentElement.style.scrollSnapType = ''; }, 600);
    }
  }
});
</script>
`;

// Presenter script: sends scroll position via WebSocket
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

  // Send scroll ratio
  var lastRatio = -1;
  var scrolling = false;
  var timer = null;

  function sendScroll() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 0) return;
    var ratio = Math.round(window.scrollY / max * 10000) / 10000;
    if (ratio !== lastRatio) {
      lastRatio = ratio;
      ws.send('slide:sync', { ratio: ratio });
    }
  }

  window.addEventListener('scroll', function() {
    if (!scrolling) { scrolling = true; sendScroll(); }
    clearTimeout(timer);
    timer = setTimeout(function() { sendScroll(); scrolling = false; }, 100);
  }, { passive: true });

  // Throttle during active scroll
  var throttle = null;
  window.addEventListener('scroll', function() {
    if (!throttle) {
      throttle = setInterval(function() {
        if (!scrolling) { clearInterval(throttle); throttle = null; return; }
        sendScroll();
      }, 100);
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
