const { stmts, getFullQuiz } = require('../db');

function handleAdminConnection(ws, query, ctx) {
  const {
    activeSessions, getOrCreateSessionState, cleanupSession,
    send, broadcastToParticipants, broadcastToDisplays, broadcastToAll, sendParticipantCount,
  } = ctx;

  let sessionId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, 'error', { message: 'Invalid JSON' });
    }

    const { type, payload } = msg;

    switch (type) {
      case 'session:join': {
        // Admin joins to control an existing session
        sessionId = Number(payload.sessionId);
        const session = stmts.getSessionById.get(sessionId);
        if (!session) return send(ws, 'error', { message: 'Session not found' });

        const state = getOrCreateSessionState(sessionId);
        state.adminWs = ws;

        // Send current state to admin
        const quiz = getFullQuiz(session.quiz_id);
        send(ws, 'session:state', {
          session,
          quiz,
          participantCount: state.participants.size,
        });
        sendParticipantCount(sessionId);
        break;
      }

      case 'session:start': {
        if (!sessionId) return send(ws, 'error', { message: 'Join a session first' });
        stmts.updateSessionStatus.run('active', sessionId);
        const session = stmts.getSessionById.get(sessionId);
        broadcastToAll(sessionId, 'session:started', {
          quizTitle: session.quiz_title,
        });
        send(ws, 'session:started', { session });
        break;
      }

      case 'block:start': {
        if (!sessionId) return;
        const blockId = Number(payload.blockId);
        stmts.updateSessionQuestion.run(blockId, null, 'idle', sessionId);
        const session = stmts.getSessionById.get(sessionId);

        // Get block info
        const quiz = getFullQuiz(session.quiz_id);
        const block = quiz.blocks.find((b) => b.id === blockId);
        if (!block) return send(ws, 'error', { message: 'Block not found' });

        broadcastToAll(sessionId, 'block:started', {
          blockId,
          blockTitle: block.title,
          questionCount: block.questions.length,
        });
        send(ws, 'block:started', {
          blockId,
          blockTitle: block.title,
          questions: block.questions,
        });
        break;
      }

      case 'question:start': {
        if (!sessionId) return;
        const questionId = Number(payload.questionId);
        const question = stmts.getQuestionById.get(questionId);
        if (!question) return send(ws, 'error', { message: 'Question not found' });

        const session = stmts.getSessionById.get(sessionId);
        stmts.updateSessionQuestion.run(session.current_block_id, questionId, 'open', sessionId);

        const state = getOrCreateSessionState(sessionId);
        state.questionStartedAt = Date.now();

        // Parse question data
        const options = JSON.parse(question.options);

        // Send question to participants (without correct answer!)
        const participantPayload = {
          questionId: question.id,
          type: question.type,
          text: question.text,
          options,
          timeLimit: question.time_limit_sec,
          blockTitle: payload.blockTitle || '',
          questionNumber: payload.questionNumber || 0,
          totalQuestions: payload.totalQuestions || 0,
        };
        broadcastToParticipants(sessionId, 'question:show', participantPayload);
        broadcastToDisplays(sessionId, 'question:show', participantPayload);

        // Send full question to admin (with correct answer)
        send(ws, 'question:started', {
          ...participantPayload,
          correctAnswer: question.correct_answer ? JSON.parse(question.correct_answer) : null,
          explanation: question.explanation,
        });

        // Start timer — auto-lock when time expires
        if (state.timerId) clearTimeout(state.timerId);
        const timerQuestionId = questionId; // Capture for closure
        state.timerId = setTimeout(() => {
          const currentSession = stmts.getSessionById.get(sessionId);
          // Only lock if this exact question is still the active open question
          if (currentSession && currentSession.question_state === 'open'
              && currentSession.current_question_id === timerQuestionId) {
            stmts.updateSessionQuestion.run(
              currentSession.current_block_id, timerQuestionId, 'locked', sessionId
            );
            broadcastToAll(sessionId, 'question:lock', {});
            send(ws, 'question:locked', {});
          }
        }, question.time_limit_sec * 1000);

        break;
      }

      case 'question:lock': {
        // Manual lock (before timer expires)
        if (!sessionId) return;
        const state = getOrCreateSessionState(sessionId);
        if (state.timerId) {
          clearTimeout(state.timerId);
          state.timerId = null;
        }
        const session = stmts.getSessionById.get(sessionId);
        if (session.question_state === 'open') {
          stmts.updateSessionQuestion.run(
            session.current_block_id, session.current_question_id, 'locked', sessionId
          );
          broadcastToAll(sessionId, 'question:lock', {});
          send(ws, 'question:locked', {});
        }
        break;
      }

      case 'question:reveal': {
        if (!sessionId) return;
        const state = getOrCreateSessionState(sessionId);
        if (state.timerId) {
          clearTimeout(state.timerId);
          state.timerId = null;
        }

        const session = stmts.getSessionById.get(sessionId);
        const questionId2 = session.current_question_id;
        if (!questionId2) return;

        stmts.updateSessionQuestion.run(
          session.current_block_id, questionId2, 'revealed', sessionId
        );

        const question = stmts.getQuestionById.get(questionId2);
        const correctAnswer = question.correct_answer ? JSON.parse(question.correct_answer) : null;
        const distribution = {};
        stmts.getAnswerDistribution.all(sessionId, questionId2).forEach((row) => {
          distribution[row.answer] = row.count;
        });

        // Send reveal to display (with stats)
        broadcastToDisplays(sessionId, 'question:reveal', {
          correctAnswer,
          explanation: question.explanation,
          distribution,
        });

        // Send personalized reveal to each participant
        for (const [pId, p] of state.participants) {
          const pResponse = stmts.getResponsesByParticipant.all(pId, sessionId)
            .find((r) => r.question_id === questionId2);
          send(p.ws, 'question:reveal', {
            correctAnswer,
            explanation: question.explanation,
            yourAnswer: pResponse ? pResponse.answer : null,
            isCorrect: pResponse ? (pResponse.is_correct === null ? null : pResponse.is_correct === 1) : null,
          });
        }

        // Send stats to admin
        const totalAnswered = stmts.countResponsesForQuestion.get(sessionId, questionId2).count;
        send(ws, 'question:revealed', {
          correctAnswer,
          explanation: question.explanation,
          distribution,
          totalAnswered,
        });
        break;
      }

      case 'question:next': {
        if (!sessionId) return;
        const session = stmts.getSessionById.get(sessionId);
        stmts.updateSessionQuestion.run(session.current_block_id, null, 'idle', sessionId);
        broadcastToAll(sessionId, 'question:next', {});
        send(ws, 'question:next', {});
        break;
      }

      case 'block:end': {
        if (!sessionId) return;
        const session = stmts.getSessionById.get(sessionId);
        const quiz = getFullQuiz(session.quiz_id);
        const block = quiz.blocks.find((b) => b.id === session.current_block_id);
        if (!block) return;

        // Calculate block stats
        const blockQuestionIds = block.questions.map((q) => q.id);
        const state2 = getOrCreateSessionState(sessionId);

        for (const [pId, p] of state2.participants) {
          const pResponses = stmts.getResponsesByParticipant.all(pId, sessionId)
            .filter((r) => blockQuestionIds.includes(r.question_id));
          const correctCount = pResponses.filter((r) => r.is_correct === 1).length;
          send(p.ws, 'block:end', {
            blockTitle: block.title,
            yourScore: correctCount,
            totalQuestions: block.questions.length,
          });
        }

        // Calculate average score for display
        let totalCorrect = 0;
        let totalParticipants = 0;
        for (const [pId] of state2.participants) {
          const pResponses = stmts.getResponsesByParticipant.all(pId, sessionId)
            .filter((r) => blockQuestionIds.includes(r.question_id));
          totalCorrect += pResponses.filter((r) => r.is_correct === 1).length;
          totalParticipants++;
        }
        const avgScore = totalParticipants > 0
          ? Math.round((totalCorrect / totalParticipants) * 10) / 10
          : 0;

        broadcastToDisplays(sessionId, 'block:end', {
          blockTitle: block.title,
          totalQuestions: block.questions.length,
          avgScore,
          participantCount: totalParticipants,
        });

        send(ws, 'block:ended', {
          blockTitle: block.title,
          avgScore,
          participantCount: totalParticipants,
        });
        break;
      }

      case 'session:end': {
        if (!sessionId) return;
        stmts.finishSession.run(sessionId);
        broadcastToAll(sessionId, 'session:ended', {});
        send(ws, 'session:ended', {});
        cleanupSession(sessionId);
        sessionId = null;
        break;
      }

      case 'slide:sync': {
        if (!sessionId) return;
        broadcastToParticipants(sessionId, 'slide:sync', { ratio: payload.ratio });
        broadcastToDisplays(sessionId, 'slide:sync', { ratio: payload.ratio });
        break;
      }

      default:
        send(ws, 'error', { message: `Unknown message type: ${type}` });
    }
  });

  ws.on('close', () => {
    if (sessionId) {
      const state = activeSessions.get(sessionId);
      if (state && state.adminWs === ws) {
        state.adminWs = null;
      }
    }
  });
}

module.exports = { handleAdminConnection };
