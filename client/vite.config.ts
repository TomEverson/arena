import { defineConfig } from "vitest/config";

const server = "http://localhost:8080";

export default defineConfig({
  server: {
    port: 5173,
    // Playing with a friend through a Cloudflare quick tunnel (`cloudflared tunnel --url
    // http://localhost:5173`): Vite refuses host names it does not know. For a tunnel on your
    // own domain, add that host name here.
    allowedHosts: [".trycloudflare.com"],
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
