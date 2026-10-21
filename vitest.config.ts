import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, configDefaults } from "vitest/config";

// Test fixtures and generated OrangePro artifacts are DATA read from disk by
// local proof-kit tests — they are not themselves runnable test suites and must
// not be picked up by vitest's `*.test.ts` glob (e.g. a fixture importing a
// `.scss` would trip vite's CSS preprocessor, and compare outputs live under
// `.orangepro/`). Keep vitest's defaults otherwise.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/__fixtures__/**", "**/.orangepro/**", "private/reviews/**"],
    // A full parallel run on a busy machine starves single tests of CPU: one that
    // takes a second alone can pass vitest's default 5 s limit. Tests that need
    // more than 30 s still set their own limit.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["tests/setup.ts"],
    // Reports record when the feedback invitation was last shown. Keep test runs
    // out of the developer's own ~/.orangepro preferences.
    env: { ORANGEPRO_FEEDBACK_PREFS: join(tmpdir(), `orangepro-vitest-feedback-prefs-${process.pid}.json`) }
  }
});
