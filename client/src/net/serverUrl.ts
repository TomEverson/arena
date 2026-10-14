/**
 * Where the game server is. In development and when the page and the server share a host, that
 * is the page's own origin (Vite proxies /ws and /api to the server). When the client is hosted
 * somewhere else (a static host, with the server on its own machine), the build is given the
 * server's address in `VITE_SERVER_URL`, e.g. `https://game.example.com`, and the server is told
 * to accept the site with `--allowed-origins`. See spec/docs/deploy.md.
 */

export interface ServerUrls {
  /** An HTTP(S) URL on the server for a path like "/api/rooms". */
  http(path: string): string;
  /** A WebSocket URL on the server for a path like "/ws?room=ABCD". */
  ws(path: string): string;
  /** A WebTransport URL on the server's host, on the UDP port it says it is on. Always https. */
  webTransport(port: number, path: string): string;
}

/**
 * `base` is the server's address ("" for the page's own origin); `page` is where the page is.
 * A page served over https talks wss, and so does a server whose address is https.
 */
export function serverUrls(base: string, page: { protocol: string; host: string }): ServerUrls {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (!trimmed) {
    const ws = page.protocol === "https:" ? "wss:" : "ws:";
    const hostname = page.host.replace(/:\d+$/, "");
    return {
      http: (path) => path,
      ws: (path) => `${ws}//${page.host}${path}`,
      webTransport: (port, path) => `https://${hostname}:${port}${path}`,
    };
  }
  const url = new URL(trimmed);
  const ws = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    http: (path) => `${url.origin}${path}`,
    ws: (path) => `${ws}//${url.host}${path}`,
    webTransport: (port, path) => `https://${url.hostname}:${port}${path}`,
  };
}

const configured = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "";

/** The server this build talks to. */
export const server: ServerUrls = serverUrls(
  configured,
  typeof location === "undefined" ? { protocol: "http:", host: "localhost" } : location,
);
