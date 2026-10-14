import { describe, expect, it } from "vitest";

import { serverUrls } from "./serverUrl";

describe("serverUrls", () => {
  it("uses the page's own origin when no server is configured", () => {
    const s = serverUrls("", { protocol: "http:", host: "localhost:5173" });
    expect(s.http("/api/rooms")).toBe("/api/rooms");
    expect(s.ws("/ws?room=ABCD")).toBe("ws://localhost:5173/ws?room=ABCD");
    // The dev server's page is on 5173; WebTransport goes straight to the game server's port.
    expect(s.webTransport(8080, "/wt?room=ABCD")).toBe("https://localhost:8080/wt?room=ABCD");
    expect(serverUrls("", { protocol: "https:", host: "play.example.com" }).ws("/ws")).toBe(
      "wss://play.example.com/ws",
    );
  });

  it("points at a server on another host, with wss for an https server", () => {
    const s = serverUrls("https://game.example.com/", {
      protocol: "https:",
      host: "arena.pages.dev",
    });
    expect(s.http("/api/rooms")).toBe("https://game.example.com/api/rooms");
    expect(s.ws("/ws?room=ABCD")).toBe("wss://game.example.com/ws?room=ABCD");
    expect(s.webTransport(443, "/wt?room=ABCD")).toBe("https://game.example.com:443/wt?room=ABCD");
  });

  it("keeps plain ws for an http server (a test machine)", () => {
    const s = serverUrls("http://10.0.0.5:8080", { protocol: "http:", host: "localhost:5173" });
    expect(s.http("/healthz")).toBe("http://10.0.0.5:8080/healthz");
    expect(s.ws("/ws")).toBe("ws://10.0.0.5:8080/ws");
  });
});
