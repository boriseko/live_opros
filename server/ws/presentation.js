/**
 * WebSocket handler for presentation slide synchronization.
 * Session-aware: presenter connects with sessionId, scroll events
 * are broadcast to all participants in that session.
 * Stores current ratio per session for late joiners.
 */

function handlePresentationConnection(ws, query, ctx) {
  const { activeSessions, getOrCreateSessionState, send,
          broadcastToParticipants, broadcastToDisplays, sendParticipantCount } = ctx;

  const role = query.role || 'presenter';
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

    // Send current viewer count
    let online = 0;
    for (const [, p] of state.participants) {
      if (p.ws && p.ws.readyState === 1) online++;
    }
    send(ws, 'viewer:count', { count: online });

    ws.on('message', (raw) => {
      try {
        const { type, payload } = JSON.parse(raw);

        if (type === 'slide:sync') {
          // Store position for late joiners (element-based: {id, offset})
          state.slidePosition = payload;
          // Broadcast to all participants and displays in this session
          broadcastToParticipants(sessionId, 'slide:sync', payload);
          broadcastToDisplays(sessionId, 'slide:sync', payload);
        }
      } catch (e) {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      if (state.presenterWs === ws) state.presenterWs = null;
    });

  } else {
    // No viewer role needed — participants connect via /ws/participant
    ws.close();
  }
}

module.exports = { handlePresentationConnection };
