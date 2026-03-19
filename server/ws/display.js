const { stmts, getFullQuiz } = require('../db');

function handleDisplayConnection(ws, query, ctx) {
  const { activeSessions, getOrCreateSessionState, send, sendParticipantCount } = ctx;

  const sessionId = Number(query.sessionId);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (!sessionId) {
    send(ws, 'error', { message: 'sessionId is required' });
    ws.close();
    return;
  }

  const session = stmts.getSessionById.get(sessionId);
  if (!session) {
    send(ws, 'error', { message: 'Session not found' });
    ws.close();
    return;
  }

  const state = getOrCreateSessionState(sessionId);
  state.displayWs.add(ws);

  // Send current state
  const quiz = getFullQuiz(session.quiz_id);
  send(ws, 'session:state', {
    session,
    quiz,
    participantCount: state.participants.size,
  });
  sendParticipantCount(sessionId);

  ws.on('close', () => {
    const s = activeSessions.get(sessionId);
    if (s) {
      s.displayWs.delete(ws);
    }
  });

  // Display doesn't send messages, only receives
  ws.on('message', () => {});
}

module.exports = { handleDisplayConnection };
