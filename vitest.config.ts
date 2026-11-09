import { defineConfig } from 'vitest/config';

// Several flight-data tests run real PGlite (PostgreSQL) databases in memory and take 10–60 s when the whole suite
// runs in parallel; the default 5 s limit is far too short for them.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], testTimeout: 180_000, hookTimeout: 180_000 },
});
