const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { stmts } = require('../db');

const router = Router();
const PRES_DIR = path.join(__dirname, '..', '..', 'data', 'presentations');

// Ensure directory exists
if (!fs.existsSync(PRES_DIR)) fs.mkdirSync(PRES_DIR, { recursive: true });

// Sync script injected into served presentations
const SYNC_SCRIPT = `
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

// GET /api/presentations/:id/file — serve HTML with injected sync script (public, no auth)
router.get('/:id/file', (req, res) => {
  const pres = stmts.getPresentationById.get(Number(req.params.id));
  if (!pres) return res.status(404).json({ error: 'Presentation not found' });

  const filePath = path.join(PRES_DIR, pres.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  let html = fs.readFileSync(filePath, 'utf8');
  // Inject sync script before </body>
  if (html.includes('</body>')) {
    html = html.replace('</body>', SYNC_SCRIPT + '\n</body>');
  } else {
    html += SYNC_SCRIPT;
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
