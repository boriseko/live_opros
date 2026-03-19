const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const dbPath = path.resolve(config.DB_PATH);
const db = new Database(dbPath);

// Performance: WAL mode for concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('choice', 'multi', 'text', 'scale')),
    text TEXT NOT NULL,
    options TEXT DEFAULT '[]',
    correct_answer TEXT DEFAULT NULL,
    explanation TEXT DEFAULT '',
    time_limit_sec INTEGER DEFAULT 60,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id),
    status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'active', 'finished')),
    current_block_id INTEGER DEFAULT NULL,
    current_question_id INTEGER DEFAULT NULL,
    question_state TEXT DEFAULT 'idle' CHECK(question_state IN ('idle', 'open', 'locked', 'revealed')),
    started_at TEXT DEFAULT NULL,
    finished_at TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    connected_at TEXT DEFAULT (datetime('now')),
    is_online INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id),
    answer TEXT NOT NULL,
    is_correct INTEGER DEFAULT NULL,
    answered_at TEXT DEFAULT (datetime('now')),
    UNIQUE(session_id, participant_id, question_id)
  );

  CREATE INDEX IF NOT EXISTS idx_blocks_quiz ON blocks(quiz_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_questions_block ON questions(block_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_participants_session ON participants(session_id);
  CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id, question_id);
  CREATE INDEX IF NOT EXISTS idx_responses_participant ON responses(participant_id);
`);

// ── Prepared Statements ───────────────────────────────────

const stmts = {
  // Quizzes
  getQuizzes: db.prepare('SELECT * FROM quizzes ORDER BY created_at DESC'),
  getQuizById: db.prepare('SELECT * FROM quizzes WHERE id = ?'),
  insertQuiz: db.prepare('INSERT INTO quizzes (title, description) VALUES (?, ?)'),
  deleteQuiz: db.prepare('DELETE FROM quizzes WHERE id = ?'),

  // Blocks
  getBlocksByQuiz: db.prepare('SELECT * FROM blocks WHERE quiz_id = ? ORDER BY sort_order'),
  insertBlock: db.prepare('INSERT INTO blocks (quiz_id, title, sort_order) VALUES (?, ?, ?)'),
  updateBlock: db.prepare('UPDATE blocks SET title = ? WHERE id = ?'),
  deleteBlock: db.prepare('DELETE FROM blocks WHERE id = ?'),
  getMaxBlockOrder: db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM blocks WHERE quiz_id = ?'),

  // Questions
  getQuestionsByBlock: db.prepare('SELECT * FROM questions WHERE block_id = ? ORDER BY sort_order'),
  getQuestionById: db.prepare('SELECT * FROM questions WHERE id = ?'),
  insertQuestion: db.prepare(
    'INSERT INTO questions (block_id, type, text, options, correct_answer, explanation, time_limit_sec, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  updateQuestion: db.prepare(
    'UPDATE questions SET type = ?, text = ?, options = ?, correct_answer = ?, explanation = ?, time_limit_sec = ? WHERE id = ?'
  ),
  deleteQuestion: db.prepare('DELETE FROM questions WHERE id = ?'),
  getMaxQuestionOrder: db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM questions WHERE block_id = ?'),

  // Sessions
  getSessions: db.prepare('SELECT s.*, q.title as quiz_title FROM sessions s JOIN quizzes q ON s.quiz_id = q.id ORDER BY s.created_at DESC'),
  getSessionById: db.prepare('SELECT s.*, q.title as quiz_title FROM sessions s JOIN quizzes q ON s.quiz_id = q.id WHERE s.id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (quiz_id) VALUES (?)'),
  updateSessionStatus: db.prepare('UPDATE sessions SET status = ?, started_at = COALESCE(started_at, datetime(\'now\')) WHERE id = ?'),
  updateSessionQuestion: db.prepare('UPDATE sessions SET current_block_id = ?, current_question_id = ?, question_state = ? WHERE id = ?'),
  finishSession: db.prepare('UPDATE sessions SET status = \'finished\', finished_at = datetime(\'now\'), question_state = \'idle\' WHERE id = ?'),

  // Participants
  getParticipantsBySession: db.prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY connected_at'),
  getParticipantById: db.prepare('SELECT * FROM participants WHERE id = ?'),
  insertParticipant: db.prepare('INSERT INTO participants (session_id, name) VALUES (?, ?)'),
  setParticipantOnline: db.prepare('UPDATE participants SET is_online = ? WHERE id = ?'),

  // Responses
  insertResponse: db.prepare(
    'INSERT OR IGNORE INTO responses (session_id, participant_id, question_id, answer, is_correct) VALUES (?, ?, ?, ?, ?)'
  ),
  getResponsesByQuestion: db.prepare('SELECT * FROM responses WHERE session_id = ? AND question_id = ?'),
  getResponsesBySession: db.prepare(
    `SELECT r.*, p.name as participant_name, q.text as question_text, q.type as question_type
     FROM responses r
     JOIN participants p ON r.participant_id = p.id
     JOIN questions q ON r.question_id = q.id
     WHERE r.session_id = ?
     ORDER BY r.answered_at`
  ),
  getResponsesByParticipant: db.prepare('SELECT * FROM responses WHERE participant_id = ? AND session_id = ?'),
  countResponsesForQuestion: db.prepare('SELECT COUNT(*) as count FROM responses WHERE session_id = ? AND question_id = ?'),
  getAnswerDistribution: db.prepare('SELECT answer, COUNT(*) as count FROM responses WHERE session_id = ? AND question_id = ? GROUP BY answer'),
};

// ── Helper Functions ──────────────────────────────────────

function getFullQuiz(quizId) {
  const quiz = stmts.getQuizById.get(quizId);
  if (!quiz) return null;

  const blocks = stmts.getBlocksByQuiz.all(quizId);
  quiz.blocks = blocks.map((block) => {
    const questions = stmts.getQuestionsByBlock.all(block.id);
    block.questions = questions.map((q) => ({
      ...q,
      options: JSON.parse(q.options),
      correct_answer: q.correct_answer ? JSON.parse(q.correct_answer) : null,
    }));
    return block;
  });

  return quiz;
}

function getSessionResults(sessionId) {
  const session = stmts.getSessionById.get(sessionId);
  if (!session) return null;

  const participants = stmts.getParticipantsBySession.all(sessionId);
  const responses = stmts.getResponsesBySession.all(sessionId);

  const quiz = getFullQuiz(session.quiz_id);
  const allQuestions = quiz ? quiz.blocks.flatMap((b) => b.questions) : [];

  // Per-participant scores
  const participantResults = participants.map((p) => {
    const pResponses = responses.filter((r) => r.participant_id === p.id);
    const correctCount = pResponses.filter((r) => r.is_correct === 1).length;
    return {
      ...p,
      responses: pResponses,
      correctCount,
      totalAnswered: pResponses.length,
    };
  });

  // Per-question stats
  const questionStats = allQuestions.map((q) => {
    const qResponses = responses.filter((r) => r.question_id === q.id);
    const distribution = {};
    qResponses.forEach((r) => {
      distribution[r.answer] = (distribution[r.answer] || 0) + 1;
    });
    const correctCount = qResponses.filter((r) => r.is_correct === 1).length;
    return {
      questionId: q.id,
      questionText: q.text,
      questionType: q.type,
      totalAnswered: qResponses.length,
      correctCount,
      correctRate: qResponses.length > 0 ? correctCount / qResponses.length : 0,
      distribution,
    };
  });

  return {
    session,
    quiz,
    participants: participantResults,
    questionStats,
    totalParticipants: participants.length,
    totalResponses: responses.length,
  };
}

module.exports = { db, stmts, getFullQuiz, getSessionResults };
