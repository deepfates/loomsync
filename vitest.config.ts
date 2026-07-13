import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@deepfates\/lync\/profiles\/text-story$/,
        replacement: new URL(
          "./src/profiles/text-story.ts",
          import.meta.url,
        ).pathname,
      },
      {
        find: /^@deepfates\/lync\/indexes\/([a-z0-9-]+)$/,
        replacement: new URL("./src/indexes/", import.meta.url).pathname + "$1.ts",
      },
      {
        find: /^@deepfates\/lync\/indexes$/,
        replacement: new URL("./src/indexes/index.ts", import.meta.url).pathname,
      },
      {
        find: /^@deepfates\/lync\/client\/([a-z0-9-]+)$/,
        replacement: new URL("./src/client/", import.meta.url).pathname + "$1.ts",
      },
      {
        find: /^@deepfates\/lync\/client$/,
        replacement: new URL("./src/client/index.ts", import.meta.url).pathname,
      },
      {
        find: /^@deepfates\/lync\/relay$/,
        replacement: new URL("./src/relay/index.ts", import.meta.url).pathname,
      },
      {
        find: /^@deepfates\/lync\/([a-z0-9-]+)$/,
        replacement: new URL("./src/", import.meta.url).pathname + "$1.ts",
      },
      {
        find: /^@deepfates\/lync$/,
        replacement: new URL("./src/index.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
