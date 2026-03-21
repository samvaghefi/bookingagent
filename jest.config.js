/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js', '!**/tests/phase1.test.js'],
  testPathIgnorePatterns: ['/node_modules/', 'tests/phase1.test.js'],
  collectCoverageFrom: [
    'server/**/*.js',
    '!server/index.js',   // integration entry point; tested via supertest
  ],
  coverageThreshold: {
    global: { lines: 60 },
  },
  // Prevent tests from calling real external services
  setupFiles: ['./tests/setup.js'],
};
