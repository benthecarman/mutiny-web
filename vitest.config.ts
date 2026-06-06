import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: [{ find: "~", replacement: path.resolve(__dirname, "./src") }]
    },
    test: {
        environment: "node",
        globals: true,
        include: ["src/**/*.test.ts"],
        setupFiles: ["./src/test/setup.ts"]
    }
});
