#!/usr/bin/env node

/**
 * Seed script: loads quiz data from data/quiz-seed.json into SQLite.
 * Usage: node server/seed.js [--force]
 *   --force  Drop existing quizzes and re-seed
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { db, stmts } = require('./db');

const seedPath = path.resolve(__dirname, '..', 'data', 'quiz-seed.json');
const seedData = require(seedPath);

const force = process.argv.includes('--force');

function seed() {
  const existing = stmts.getQuizzes.all();

  if (existing.length > 0 && !force) {
    console.log(`Database already has ${existing.length} quiz(zes). Use --force to re-seed.`);
    process.exit(0);
  }

  if (force) {
    console.log('Force mode: clearing existing data...');
    db.exec('DELETE FROM responses; DELETE FROM participants; DELETE FROM sessions; DELETE FROM questions; DELETE FROM blocks; DELETE FROM quizzes;');
  }

  const insertAll = db.transaction(() => {
    // Insert quiz
    const quizResult = stmts.insertQuiz.run(seedData.title, seedData.description || '');
    const quizId = quizResult.lastInsertRowid;
    console.log(`Created quiz: "${seedData.title}" (id: ${quizId})`);

    // Insert blocks and questions
    seedData.blocks.forEach((block, blockIdx) => {
      const blockResult = stmts.insertBlock.run(quizId, block.title, blockIdx);
      const blockId = blockResult.lastInsertRowid;
      console.log(`  Block ${blockIdx + 1}: "${block.title}" (${block.questions.length} questions)`);

      block.questions.forEach((q, qIdx) => {
        const correctAnswer = q.correct_answer !== null
          ? JSON.stringify(q.correct_answer)
          : null;

        stmts.insertQuestion.run(
          blockId,
          q.type,
          q.text,
          JSON.stringify(q.options || []),
          correctAnswer,
          q.explanation || '',
          q.time_limit_sec || 30,
          qIdx
        );
      });
    });

    const totalQuestions = seedData.blocks.reduce((sum, b) => sum + b.questions.length, 0);
    console.log(`\nDone! Seeded ${seedData.blocks.length} blocks, ${totalQuestions} questions.`);
  });

  insertAll();
}

seed();
