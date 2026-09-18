import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "test/.tmp/**", "dist/**"],
    // Several suites spawn child processes and a local HTTP server; the defaults are too
    // tight for the concurrency test and too loose for a hung request.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Forks, not threads: the setup file changes directory, which a worker thread may not.
    pool: "forks",
    setupFiles: ["test/setup-cwd.ts"],
    poolOptions: { forks: { singleFork: false, maxForks: 4 } },
    reporters: ["default"],
  },
});
