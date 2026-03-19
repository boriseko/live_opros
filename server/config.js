require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3002,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'nmtech2024',
  SESSION_SECRET: process.env.SESSION_SECRET || 'change-me-in-production',
  DB_PATH: process.env.DB_PATH || './data/live_opros.db',
};
