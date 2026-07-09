import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^lync-core\/profiles\/text-story$/,
        replacement: new URL(
          "./packages/core/src/profiles/text-story.ts",
          import.meta.url,
        ).pathname,
      },
      {
        find: /^lync-core\/([a-z0-9-]+)$/,
        replacement: new URL("./packages/core/src/", import.meta.url).pathname + "$1.ts",
      },
      {
        find: /^lync-core$/,
        replacement: new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
