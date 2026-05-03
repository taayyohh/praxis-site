import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Playwright spec files (.spec.js) are run by `npx playwright test`, not vitest.
    // Default vitest include picks up *.spec.* — explicitly limit to *.test.*.
    include: ['tests/**/*.test.{js,ts}'],
  },
})
