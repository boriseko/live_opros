const crypto = require('crypto');
const config = require('../config');

/**
 * Express middleware: checks signed cookie for admin authentication.
 * Responds 401 if not authenticated.
 */
function requireAuth(req, res, next) {
  if (req.signedCookies && req.signedCookies.session === 'admin') {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Verify admin password using timing-safe comparison.
 * Returns true if password matches ADMIN_PASSWORD env var.
 */
function verifyPassword(password) {
  const expected = config.ADMIN_PASSWORD;
  if (typeof password !== 'string' || password.length === 0) return false;

  // Timing-safe comparison to prevent timing attacks
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Check admin cookie on WebSocket upgrade request.
 * Used to verify admin WS connections.
 */
function verifyAdminCookie(req, secret) {
  const cookieParser = require('cookie-parser');
  // cookie-parser stores signed cookies in req.signedCookies after middleware
  // For WS upgrade, we need to parse manually
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return false;

  const cookies = require('cookie').parse(cookieHeader);
  const signed = cookies.session;
  if (!signed) return false;

  // Unsigned the cookie value (format: s:<value>.<signature>)
  if (signed.startsWith('s:')) {
    const val = cookieParser.signedCookie(signed, secret);
    return val === 'admin';
  }

  return false;
}

module.exports = { requireAuth, verifyPassword, verifyAdminCookie };
