/**
 * The player's username: asked for on the start menu and kept in the browser (localStorage),
 * so it is asked once. It is only stored for now: the server and other players do not see it yet.
 */

export const USERNAME_KEY = "arena.name";
export const USERNAME_MAX = 16;

/** What someone typed, made fit to keep: one line, single spaces, no control characters, at most USERNAME_MAX long. */
export function cleanUsername(raw: string): string {
  return [...raw]
    .map((ch) => ((ch.codePointAt(0) ?? 0) < 32 || ch === "\u007f" ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, USERNAME_MAX)
    .trim();
}

/** The stored username, or "" if there is none (or no storage, as in the unit tests). */
export function loadUsername(): string {
  if (typeof localStorage === "undefined") return "";
  return cleanUsername(localStorage.getItem(USERNAME_KEY) ?? "");
}

/** Keep a username; returns what was kept ("" keeps nothing and forgets the old one). */
export function saveUsername(raw: string): string {
  const name = cleanUsername(raw);
  if (typeof localStorage === "undefined") return name;
  if (name) localStorage.setItem(USERNAME_KEY, name);
  else localStorage.removeItem(USERNAME_KEY);
  return name;
}
