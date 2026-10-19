import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: [
      "src/**/__tests__/**/*.test.{ts,tsx}",
      "extension/src/**/__tests__/**/*.test.{ts,tsx}",
      "examples/**/src/**/*.test.{ts,tsx}",
    ],
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.test.json",
      include: ["src/**/__tests__/**/*.test-d.ts"],
    },
    setupFiles: ["src/__tests__/setup.ts"],
    passWithNoTests: true,
  },
});
