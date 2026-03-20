/**
 * WebSocket handler for presentation slide synchronization.
 * Presenter scrolls → all viewers auto-scroll to the same position.
 * Uses scroll RATIO (0.0–1.0) for viewport-independent sync.
 * No database, no sessions — pure in-memory state.
 */

let presenterWs = null;
let viewers = new Set();
let currentRatio = 0;

function broadcastToViewers(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const ws of viewers) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function sendViewerCount() {
  let online = 0;
  for (const ws of viewers) {
    if (ws.readyState === 1) online++;
  }
  const payload = { count: online };
  broadcastToViewers('viewer:count', payload);
  if (presenterWs && presenterWs.readyState === 1) {
    presenterWs.send(JSON.stringify({ type: 'viewer:count', payload }));
  }
}

function handlePresentationConnection(ws, query, ctx) {
  const { send } = ctx;
  const role = query.role || 'viewer';

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'presenter') {
    presenterWs = ws;

    ws.on('message', (raw) => {
      try {
        const { type, payload } = JSON.parse(raw);

        if (type === 'slide:sync') {
          currentRatio = payload.ratio;
          broadcastToViewers('slide:sync', { ratio: currentRatio });
        } else if (type === 'slide:quiztime') {
          broadcastToViewers('slide:quiztime', payload || {});
        }
      } catch (e) {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      if (presenterWs === ws) presenterWs = null;
    });

    sendViewerCount();

  } else {
    viewers.add(ws);

    // Send current position immediately so viewer catches up
    send(ws, 'slide:sync', { ratio: currentRatio });
    sendViewerCount();

    ws.on('close', () => {
      viewers.delete(ws);
      sendViewerCount();
    });

    ws.on('message', () => {});
  }
}

module.exports = { handlePresentationConnection };
