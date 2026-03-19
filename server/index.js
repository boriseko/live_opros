const path = require('path');
const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const config = require('./config');
require('./db'); // Init database on startup
const { setupWebSocket } = require('./ws/index');

const app = express();

// ── Middleware ─────────────────────────────────────────────

// Rate limit login attempts (in-memory, simple)
const loginAttempts = new Map();
function rateLimitLogin(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const window = 60 * 1000; // 1 minute
  const maxAttempts = 10;

  if (!loginAttempts.has(ip)) loginAttempts.set(ip, []);
  const attempts = loginAttempts.get(ip).filter(t => now - t < window);
  loginAttempts.set(ip, attempts);

  if (attempts.length >= maxAttempts) {
    return res.status(429).json({ error: 'Too many attempts, try again in 1 minute' });
  }
  attempts.push(now);
  next();
}

// Limit JSON body size (prevents huge text answers)
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser(config.SESSION_SECRET));

// Inject BASE_PATH into HTML pages for correct asset loading
const BASE_PATH = config.BASE_PATH;
if (BASE_PATH) {
  app.use((req, res, next) => {
    // Rewrite HTML responses to include base tag
    const originalSend = res.send.bind(res);
    res.send = function(body) {
      if (typeof body === 'string' && body.includes('</head>') && req.accepts('html')) {
        body = body.replace('</head>', `<base href="${BASE_PATH}/">\n</head>`);
      }
      return originalSend(body);
    };
    next();
  });
}

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API Routes ────────────────────────────────────────────

app.use('/api/auth', rateLimitLogin, require('./routes/auth'));
app.use('/api/quizzes', require('./routes/quiz'));
app.use('/api/sessions', require('./routes/session'));

// ── Admin page guard ──────────────────────────────────────

app.get('/admin.html', (req, res, next) => {
  if (req.signedCookies && req.signedCookies.session === 'admin') {
    return next();
  }
  res.redirect('/login.html');
});

// ── HTTP Server + WebSocket ───────────────────────────────

const server = http.createServer(app);
setupWebSocket(server);

server.listen(config.PORT, () => {
  const base = BASE_PATH || '';
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         Live Opros — Quiz System         ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  http://localhost:${config.PORT}${base}/              ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
