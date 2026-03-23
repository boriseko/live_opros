/**
 * WebSocket handler for presentation slide synchronization.
 * Presenter sends scroll ratio → broadcast to all viewers.
 * Stores last position for late joiners.
 */

function handlePresentationConnection(ws, query, ctx) {
  const { getOrCreateSessionState, send } = ctx;

  const role = query.role || 'viewer';
  const sessionId = Number(query.sessionId);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (!sessionId) {
    send(ws, 'error', { message: 'sessionId is required' });
    ws.close();
    return;
  }

  const state = getOrCreateSessionState(sessionId);

  if (role === 'presenter') {
    state.presenterWs = ws;
    send(ws, 'viewer:count', { count: state.presViewers.size });

    ws.on('message', (raw) => {
      try {
        const { type, payload } = JSON.parse(raw);
        if (type === 'slide:sync') {
          state.slidePosition = payload;
          const msg = JSON.stringify({ type: 'slide:sync', payload });
          for (const v of state.presViewers) {
            if (v.readyState === 1) v.send(msg);
          }
        }
      } catch (e) { /* ignore malformed */ }
    });

    ws.on('close', () => {
      if (state.presenterWs === ws) state.presenterWs = null;
    });

  } else {
    // Viewer
    state.presViewers.add(ws);

    // Late joiner: send current position
    if (state.slidePosition) {
      send(ws, 'slide:sync', state.slidePosition);
    }

    // Notify presenter of viewer count
    sendViewerCount(state);

    ws.on('close', () => {
      state.presViewers.delete(ws);
      sendViewerCount(state);
    });
  }
}

function sendViewerCount(state) {
  if (state.presenterWs && state.presenterWs.readyState === 1) {
    const msg = JSON.stringify({
      type: 'viewer:count',
      payload: { count: state.presViewers.size },
    });
    state.presenterWs.send(msg);
  }
}

module.exports = { handlePresentationConnection };
