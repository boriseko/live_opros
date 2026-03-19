const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const { stmts, getFullQuiz } = require('../db');

const router = Router();

// All quiz routes require auth
router.use(requireAuth);

// GET /api/quizzes — list all quizzes
router.get('/', (req, res) => {
  const quizzes = stmts.getQuizzes.all();
  const result = quizzes.map((quiz) => {
    const blocks = stmts.getBlocksByQuiz.all(quiz.id);
    const questionCount = blocks.reduce((sum, b) => {
      return sum + stmts.getQuestionsByBlock.all(b.id).length;
    }, 0);
    return { ...quiz, blockCount: blocks.length, questionCount };
  });
  res.json(result);
});

// POST /api/quizzes — create new quiz
router.post('/', (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const result = stmts.insertQuiz.run(title, description || '');
  res.status(201).json({ id: Number(result.lastInsertRowid), title });
});

// DELETE /api/quizzes/:id — delete quiz and all its data
router.delete('/:id', (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = stmts.getQuizById.get(quizId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  stmts.deleteQuiz.run(quizId);
  res.json({ success: true });
});

// GET /api/quizzes/:id — get full quiz with blocks and questions
router.get('/:id', (req, res) => {
  const quiz = getFullQuiz(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  res.json(quiz);
});

// ── Blocks CRUD ──────────────────────────────────────────

// POST /api/quizzes/:id/blocks — add block
router.post('/:id/blocks', (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = stmts.getQuizById.get(quizId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const maxOrder = stmts.getMaxBlockOrder.get(quizId).max_order;
  const result = stmts.insertBlock.run(quizId, title, maxOrder + 1);
  res.status(201).json({ id: Number(result.lastInsertRowid), title, sort_order: maxOrder + 1 });
});

// PUT /api/blocks/:id — update block title
router.put('/blocks/:id', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  stmts.updateBlock.run(title, Number(req.params.id));
  res.json({ success: true });
});

// DELETE /api/blocks/:id — delete block and its questions
router.delete('/blocks/:id', (req, res) => {
  stmts.deleteBlock.run(Number(req.params.id));
  res.json({ success: true });
});

// ── Questions CRUD ───────────────────────────────────────

// POST /api/blocks/:id/questions — add question
router.post('/blocks/:id/questions', (req, res) => {
  const blockId = Number(req.params.id);
  const { type, text, options, correct_answer, explanation, time_limit_sec } = req.body;

  if (!type || !text) return res.status(400).json({ error: 'type and text are required' });

  const maxOrder = stmts.getMaxQuestionOrder.get(blockId).max_order;
  const result = stmts.insertQuestion.run(
    blockId,
    type,
    text,
    JSON.stringify(options || []),
    correct_answer !== undefined && correct_answer !== null ? JSON.stringify(correct_answer) : null,
    explanation || '',
    time_limit_sec || 30,
    maxOrder + 1
  );
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

// PUT /api/questions/:id — update question
router.put('/questions/:id', (req, res) => {
  const questionId = Number(req.params.id);
  const existing = stmts.getQuestionById.get(questionId);
  if (!existing) return res.status(404).json({ error: 'Question not found' });

  const { type, text, options, correct_answer, explanation, time_limit_sec } = req.body;

  stmts.updateQuestion.run(
    type || existing.type,
    text || existing.text,
    options !== undefined ? JSON.stringify(options) : existing.options,
    correct_answer !== undefined
      ? (correct_answer !== null ? JSON.stringify(correct_answer) : null)
      : existing.correct_answer,
    explanation !== undefined ? explanation : existing.explanation,
    time_limit_sec !== undefined ? time_limit_sec : existing.time_limit_sec,
    questionId
  );
  res.json({ success: true });
});

// DELETE /api/questions/:id — delete question
router.delete('/questions/:id', (req, res) => {
  stmts.deleteQuestion.run(Number(req.params.id));
  res.json({ success: true });
});

module.exports = router;
