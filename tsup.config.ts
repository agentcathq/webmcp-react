import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/types.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom", "zod", "zod/v3", "zod/v4/core", "zod-to-json-schema"],
  treeshake: true,
  minify: false,
  banner: { js: '"use client";' },
});
