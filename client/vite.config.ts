import { defineConfig } from "vitest/config";

const server = "http://localhost:8080";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: server, ws: true },
      "/healthz": { target: server },
      "/api": { target: server },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
