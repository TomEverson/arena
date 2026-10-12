import ffa from "../../levels/ffa.json";
import greybox from "../../levels/greybox.json";
import { type Level, parseLevel } from "./sim/level";

/**
 * The maps the client can play on. The server says which one a room runs (the welcome
 * message names it) and the client loads the same one, so prediction and the server agree
 * on the geometry. Add a map here when it is added to /levels.
 */
const RAW: Record<string, unknown> = { greybox, ffa };

/** The level of this name, or undefined if the client does not have it. */
export function levelByName(name: string): Level | undefined {
  const raw = RAW[name];
  return raw === undefined ? undefined : parseLevel(raw);
}

/** Names of every map the client has. */
export const LEVEL_NAMES: readonly string[] = Object.keys(RAW);
