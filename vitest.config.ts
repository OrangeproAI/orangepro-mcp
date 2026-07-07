import { defineConfig, configDefaults } from "vitest/config";

// Test fixtures and generated OrangePro artifacts are DATA read from disk by
// local proof-kit tests — they are not themselves runnable test suites and must
// not be picked up by vitest's `*.test.ts` glob (e.g. a fixture importing a
// `.scss` would trip vite's CSS preprocessor, and compare outputs live under
// `.orangepro/`). Keep vitest's defaults otherwise.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/__fixtures__/**", "**/.orangepro/**", "private/reviews/**"]
  }
});
