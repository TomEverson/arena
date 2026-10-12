/** Rooms: one match each. A friend joins by opening the same link, `/?room=<code>`. */

export interface RoomInfo {
  code: string;
  players: number;
  maxPlayers: number;
}

/** The room code in the page URL, upper-cased, or null. */
export function roomFromUrl(search: string): string | null {
  const code = new URLSearchParams(search).get("room")?.trim().toUpperCase();
  return code ? code : null;
}

/** The shareable link for a room, on the page's own origin. */
export function roomLink(origin: string, pathname: string, code: string): string {
  return `${origin}${pathname}?room=${encodeURIComponent(code)}`;
}

export type GameMode = "ffa" | "practice";

/** `?mode=practice` or `?mode=ffa` in the page URL: skip the start screen, or null. */
export function modeFromUrl(search: string): GameMode | null {
  const mode = new URLSearchParams(search).get("mode")?.trim().toLowerCase();
  return mode === "ffa" || mode === "practice" ? mode : null;
}

/** Ask the server for a brand new room of this mode. Throws if the server cannot be reached or is full. */
export async function createRoom(mode: GameMode = "ffa"): Promise<RoomInfo> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`could not create a room (${res.status})`);
  const body = (await res.json()) as { code: string; maxPlayers: number };
  return { code: body.code, players: 0, maxPlayers: body.maxPlayers };
}

/** WebSocket close codes the server uses to say why it refused us (see server/internal/gameserver). */
export const CLOSE_ROOM_NOT_FOUND = 4001;
export const CLOSE_ROOM_FULL = 4002;

export function closeReason(code: number): string | null {
  if (code === CLOSE_ROOM_NOT_FOUND) return "This room does not exist (it may have closed).";
  if (code === CLOSE_ROOM_FULL) return "This room is full.";
  return null;
}
