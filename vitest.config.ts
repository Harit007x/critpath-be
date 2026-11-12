import { defineConfig } from "vitest/config";

/**
 * Unit tests only — no database, no network, no render service.
 *
 * Every module under test here is a pure function of its arguments, or is made
 * one by mocking `src/utils/db`. That is deliberate: the parts of this codebase
 * worth a unit test are the ones that decide a number (a quota, a beat boundary,
 * a reveal time) where being wrong is silent. Anything that needs Chromium or a
 * Cloudinary derivative is covered by `scripts/` instead.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // The element kit renders through react-dom/server, which reads NODE_ENV.
    env: { NODE_ENV: "test" },
  },
  esbuild: { jsx: "automatic" },
});
