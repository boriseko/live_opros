const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { stmts, getFullQuiz, getSessionResults } = require('../db');

const router = Router();

// All session routes require auth
router.use(requireAuth);

// POST /api/sessions — create a new session for a quiz
router.post('/', (req, res) => {
  const { quizId } = req.body;
  if (!quizId) {
    return res.status(400).json({ error: 'quizId is required' });
  }

  const quiz = getFullQuiz(Number(quizId));
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }

  const result = stmts.insertSession.run(Number(quizId));
  const session = stmts.getSessionById.get(result.lastInsertRowid);
  res.status(201).json(session);
});

// GET /api/sessions — list all sessions
router.get('/', (req, res) => {
  const sessions = stmts.getSessions.all();
  // Add participant count for each session
  const result = sessions.map((s) => {
    const participants = stmts.getParticipantsBySession.all(s.id);
    return {
      ...s,
      participantCount: participants.length,
    };
  });
  res.json(result);
});

// GET /api/sessions/:id — get session details
router.get('/:id', (req, res) => {
  const session = stmts.getSessionById.get(Number(req.params.id));
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const participants = stmts.getParticipantsBySession.all(session.id);
  res.json({ ...session, participants });
});

// GET /api/sessions/:id/results — get full session results
router.get('/:id/results', (req, res) => {
  const results = getSessionResults(Number(req.params.id));
  if (!results) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(results);
});

module.exports = router;
