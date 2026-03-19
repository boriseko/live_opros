const { Router } = require('express');
const { verifyPassword } = require('../middleware/auth');

const router = Router();

// POST /api/auth/login — authenticate admin with password
router.post('/login', (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }

  if (verifyPassword(password)) {
    // Set signed httpOnly cookie, valid for 24 hours
    res.cookie('session', 'admin', {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });
    return res.json({ success: true });
  }

  res.status(401).json({ error: 'Invalid password' });
});

// POST /api/auth/logout — clear session cookie
router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ success: true });
});

// GET /api/auth/check — check if currently authenticated
router.get('/check', (req, res) => {
  const authenticated = req.signedCookies && req.signedCookies.session === 'admin';
  res.json({ authenticated });
});

module.exports = router;
