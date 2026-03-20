const { WebSocketServer } = require('ws');
const { verifyAdminCookie } = require('../middleware/auth');
const config = require('../config');
const { handleAdminConnection } = require('./admin');
const { handleParticipantConnection } = require('./participant');
const { handleDisplayConnection } = require('./display');
const { handlePresentationConnection } = require('./presentation');

// ── Shared State ──────────────────────────────────────────

/**
 * Global state for active sessions.
 * Map<sessionId, SessionState>
 *
 * SessionState: {
 *   adminWs: WebSocket | null,
 *   displayWs: Set<WebSocket>,
 *   participants: Map<participantId, { ws, name }>,
 *   timerId: NodeJS.Timeout | null,
 *   questionStartedAt: number | null,
 * }
 */
const activeSessions = new Map();

function getOrCreateSessionState(sessionId) {
  if (!activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, {
      adminWs: null,
      displayWs: new Set(),
      participants: new Map(),
      timerId: null,
      questionStartedAt: null,
    });
  }
  return activeSessions.get(sessionId);
}

function cleanupSession(sessionId) {
  const state = activeSessions.get(sessionId);
  if (state) {
    if (state.timerId) clearTimeout(state.timerId);
    activeSessions.delete(sessionId);
  }
}

// ── Broadcast Helpers ─────────────────────────────────────

function send(ws, type, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcastToParticipants(sessionId, type, payload) {
  const state = activeSessions.get(sessionId);
  if (!state) return;
  const msg = JSON.stringify({ type, payload });
  for (const [, p] of state.participants) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(msg);
    }
  }
}

function broadcastToDisplays(sessionId, type, payload) {
  const state = activeSessions.get(sessionId);
  if (!state) return;
  const msg = JSON.stringify({ type, payload });
  for (const ws of state.displayWs) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function broadcastToAll(sessionId, type, payload) {
  broadcastToParticipants(sessionId, type, payload);
  broadcastToDisplays(sessionId, type, payload);
}

function sendParticipantCount(sessionId) {
  const state = activeSessions.get(sessionId);
  if (!state) return;

  let online = 0;
  for (const [, p] of state.participants) {
    if (p.ws && p.ws.readyState === 1) online++;
  }
  const total = state.participants.size;
  const payload = { online, total };

  send(state.adminWs, 'participant:count', payload);
  broadcastToDisplays(sessionId, 'participant:count', payload);
  broadcastToParticipants(sessionId, 'participant:count', payload);
}

// ── WebSocket Server Setup ────────────────────────────────

function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsed.pathname;
    const query = Object.fromEntries(parsed.searchParams);

    if (pathname === '/ws/admin') {
      // Verify admin cookie
      if (!verifyAdminCookie(req, config.SESSION_SECRET)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleAdminConnection(ws, query, {
          activeSessions, getOrCreateSessionState, cleanupSession,
          send, broadcastToParticipants, broadcastToDisplays, broadcastToAll, sendParticipantCount,
        });
      });
    } else if (pathname === '/ws/participant') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleParticipantConnection(ws, query, {
          activeSessions, getOrCreateSessionState,
          send, broadcastToParticipants, broadcastToDisplays, sendParticipantCount,
        });
      });
    } else if (pathname === '/ws/display') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleDisplayConnection(ws, query, {
          activeSessions, getOrCreateSessionState,
          send, sendParticipantCount,
        });
      });
    } else if (pathname === '/ws/presentation') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handlePresentationConnection(ws, query, { send });
      });
    } else {
      socket.destroy();
    }
  });

  // Heartbeat: detect broken connections
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));

  return wss;
}

module.exports = {
  setupWebSocket,
  activeSessions,
  getOrCreateSessionState,
  cleanupSession,
  send,
  broadcastToParticipants,
  broadcastToDisplays,
  broadcastToAll,
  sendParticipantCount,
};
