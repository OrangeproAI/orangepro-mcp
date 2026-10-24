import { defineConfig } from "vitest/config";

// This folder is its own project. A config here stops `vitest` from walking up
// to the repo root config, whose setupFiles path is relative to the process cwd.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"]
  }
});
