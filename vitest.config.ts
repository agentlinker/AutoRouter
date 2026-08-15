import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [".claude/**", "node_modules/**", "dist/**"]
  }
});
