const { stmts } = require('../db');

/**
 * Sanitize user input to prevent XSS when displayed.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function handleParticipantConnection(ws, query, ctx) {
  const {
    activeSessions, getOrCreateSessionState,
    send, broadcastToDisplays, sendParticipantCount,
  } = ctx;

  const sessionId = Number(query.sessionId);
  let participantId = null;

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

  if (session.status === 'finished') {
    send(ws, 'session:ended', {});
    ws.close();
    return;
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, 'error', { message: 'Invalid JSON' });
    }

    const { type, payload } = msg;

    switch (type) {
      case 'participant:join': {
        const name = escapeHtml((payload.name || '').trim());
        if (!name || name.length === 0) {
          return send(ws, 'error', { message: 'Name is required' });
        }
        if (name.length > 50) {
          return send(ws, 'error', { message: 'Name too long (max 50 chars)' });
        }

        // Check if reconnecting with existing participantId
        if (payload.participantId) {
          const existing = stmts.getParticipantById.get(Number(payload.participantId));
          if (existing && existing.session_id === sessionId) {
            participantId = existing.id;
            const state = getOrCreateSessionState(sessionId);
            // Close old WebSocket if still open
            const oldP = state.participants.get(participantId);
            if (oldP && oldP.ws && oldP.ws.readyState === 1) {
              oldP.ws.close();
            }
            state.participants.set(participantId, { ws, name: existing.name });
            stmts.setParticipantOnline.run(1, participantId);

            send(ws, 'participant:joined', {
              participantId,
              name: existing.name,
              reconnected: true,
            });
            sendParticipantCount(sessionId);

            // Send current state if session is active
            sendCurrentState(ws, sessionId, participantId);
            return;
          }
        }

        // New participant
        const result = stmts.insertParticipant.run(sessionId, name);
        participantId = result.lastInsertRowid;

        const state = getOrCreateSessionState(sessionId);
        state.participants.set(participantId, { ws, name });

        send(ws, 'participant:joined', {
          participantId: Number(participantId),
          name,
          reconnected: false,
        });

        sendParticipantCount(sessionId);

        // If session already active, send current question
        sendCurrentState(ws, sessionId, participantId);
        break;
      }

      case 'answer:submit': {
        if (!participantId) {
          return send(ws, 'error', { message: 'Join first' });
        }

        const currentSession = stmts.getSessionById.get(sessionId);
        if (!currentSession || currentSession.status !== 'active' || currentSession.question_state !== 'open') {
          return send(ws, 'error', { message: 'Question is not open for answers' });
        }

        const questionId = currentSession.current_question_id;
        if (!questionId) {
          return send(ws, 'error', { message: 'No active question' });
        }

        const question = stmts.getQuestionById.get(questionId);
        const answer = payload.answer;
        if (answer === undefined || answer === null) {
          return send(ws, 'error', { message: 'Answer is required' });
        }

        // Limit answer length
        const answerLen = typeof answer === 'string' ? answer.length : JSON.stringify(answer).length;
        if (answerLen > 5000) {
          return send(ws, 'error', { message: 'Answer too long (max 5000 chars)' });
        }

        // Determine correctness
        let isCorrect = null;
        if (question.correct_answer) {
          const correct = JSON.parse(question.correct_answer);
          if (question.type === 'choice') {
            isCorrect = answer === correct ? 1 : 0;
          } else if (question.type === 'multi') {
            // Multi: compare arrays (order-independent)
            const answerArr = Array.isArray(answer) ? answer.sort() : [];
            const correctArr = Array.isArray(correct) ? correct.sort() : [];
            isCorrect = JSON.stringify(answerArr) === JSON.stringify(correctArr) ? 1 : 0;
          }
          // text and scale: isCorrect stays null
        }

        const answerStr = typeof answer === 'string' ? answer : JSON.stringify(answer);

        // INSERT OR IGNORE — prevents double submit
        const insertResult = stmts.insertResponse.run(
          sessionId, participantId, questionId, answerStr, isCorrect
        );

        if (insertResult.changes === 0) {
          return send(ws, 'answer:already_submitted', {});
        }

        send(ws, 'answer:accepted', { questionId });

        // Update live stats for admin and display
        const distribution = {};
        stmts.getAnswerDistribution.all(sessionId, questionId).forEach((row) => {
          distribution[row.answer] = row.count;
        });
        const totalAnswered = stmts.countResponsesForQuestion.get(sessionId, questionId).count;
        const state = getOrCreateSessionState(sessionId);

        const statsPayload = {
          questionId,
          totalParticipants: state.participants.size,
          totalAnswered,
          distribution,
        };

        send(state.adminWs, 'stats:live', statsPayload);
        broadcastToDisplays(sessionId, 'stats:live', statsPayload);
        break;
      }

      default:
        send(ws, 'error', { message: `Unknown message type: ${type}` });
    }
  });

  ws.on('close', () => {
    if (participantId) {
      stmts.setParticipantOnline.run(0, participantId);
      const state = activeSessions.get(sessionId);
      if (state) {
        const p = state.participants.get(participantId);
        if (p) p.ws = null;
      }
      sendParticipantCount(sessionId);
    }
  });
}

/**
 * Send current session state to a participant who just joined or reconnected.
 */
function sendCurrentState(ws, sessionId, participantId) {
  const session = stmts.getSessionById.get(sessionId);
  if (!session) return;

  // Send current slide position for late joiners
  const { activeSessions } = require('./index');
  const sessionState = activeSessions.get(sessionId);
  if (sessionState && typeof sessionState.slideRatio === 'number') {
    send(ws, 'slide:sync', { ratio: sessionState.slideRatio });
  }

  if (session.status === 'waiting') {
    send(ws, 'session:waiting', { quizTitle: session.quiz_title });
    return;
  }

  if (session.status === 'finished') {
    send(ws, 'session:ended', {});
    return;
  }

  // Session is active
  if (session.question_state === 'open' && session.current_question_id) {
    const question = stmts.getQuestionById.get(session.current_question_id);
    if (question) {
      // Check if already answered
      const existing = stmts.getResponsesByParticipant.all(participantId, sessionId)
        .find((r) => r.question_id === question.id);
      if (existing) {
        send(ws, 'answer:already_submitted', {});
      } else {
        send(ws, 'question:show', {
          questionId: question.id,
          type: question.type,
          text: question.text,
          options: JSON.parse(question.options),
          timeLimit: question.time_limit_sec,
        });
      }
    }
  } else if (session.question_state === 'locked' || session.question_state === 'revealed') {
    // Show waiting state
    send(ws, 'session:waiting', { quizTitle: session.quiz_title });
  } else {
    send(ws, 'session:waiting', { quizTitle: session.quiz_title });
  }
}

function send(ws, type, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

module.exports = { handleParticipantConnection };
