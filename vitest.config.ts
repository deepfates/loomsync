import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^lync-core\/profiles\/text-story$/,
        replacement: new URL(
          "./src/profiles/text-story.ts",
          import.meta.url,
        ).pathname,
      },
      {
        find: /^lync-core\/indexes\/([a-z0-9-]+)$/,
        replacement: new URL("./src/indexes/", import.meta.url).pathname + "$1.ts",
      },
      {
        find: /^lync-core\/indexes$/,
        replacement: new URL("./src/indexes/index.ts", import.meta.url).pathname,
      },
      {
        find: /^lync-core\/client\/([a-z0-9-]+)$/,
        replacement: new URL("./src/client/", import.meta.url).pathname + "$1.ts",
      },
      {
        find: /^lync-core\/client$/,
        replacement: new URL("./src/client/index.ts", import.meta.url).pathname,
      },
      {
        find: /^lync-core\/relay$/,
        replacement: new URL("./src/relay/index.ts", import.meta.url).pathname,
      },
      {
        find: /^lync-core\/([a-z0-9-]+)$/,
        replacement: new URL("./src/", import.meta.url).pathname + "$1.ts",
      },
      {
        find: /^lync-core$/,
        replacement: new URL("./src/index.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
