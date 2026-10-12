import * as THREE from "three";

/**
 * The game's color palette. See spec/art/style-guide.md.
 * Every color in the game comes from this list: the screen effect in render.ts
 * snaps every pixel to these colors, so anything else can't reach the screen.
 */
export const PALETTE_HEX = {
  // Neutrals: the world (about 90% of the screen).
  INK: "#0b0b0d", // deepest shadows, outlines
  GRAPHITE: "#2a2c31", // dark metal, floors in shadow
  CONCRETE: "#7a7e86", // mid-grey structures
  HAZE: "#b9bcc2", // sky and distance fog
  BONE: "#e8e4d8", // clean off-white walls
  // Accents: small areas only, one meaning each.
  ACID: "#c6ff1a", // traversal: "you can go here"
  HAZARD: "#ff4b1f", // danger: gunfire, hits, enemies
  SIGNAL: "#2de2e6", // technology: light strips, screens, HUD
} as const;

export type PaletteName = keyof typeof PALETTE_HEX;

/** The same colors as THREE.Color objects. Shared: clone before modifying. */
export const PALETTE = Object.fromEntries(
  Object.entries(PALETTE_HEX).map(([name, hex]) => [name, new THREE.Color(hex)]),
) as Record<PaletteName, THREE.Color>;
