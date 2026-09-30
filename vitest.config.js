import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Playwright spec files (.spec.js) are run by `npx playwright test`, not vitest.
    // Default vitest include picks up *.spec.* — explicitly limit to *.test.*.
    include: ['tests/**/*.test.{js,ts}'],
    // Bump the worker RPC timeout. Default is 5s; deploys were
    // aborting on "[vitest-worker]: Timeout calling onTaskUpdate"
    // under high test load on the VPS (4 CPU box running 76 test
    // files in parallel). The worker was healthy — reporting back
    // was just slow. 30s gives real headroom without hiding actual
    // stalls.
    testTimeout: 30_000,
    teardownTimeout: 30_000,
    hookTimeout: 30_000,
    // Same for the RPC call vitest uses internally between worker
    // and main thread.
    poolOptions: {
      threads: {
        // Cap worker count on constrained boxes so the RPC channel
        // isn't oversubscribed. Undefined = one per CPU (default).
        maxThreads: 4,
        minThreads: 1,
      },
    },
  },
})
