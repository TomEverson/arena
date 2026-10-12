// Generates levels/ffa.json, the first FFA map (unnamed, greybox). Run: node levels/gen-ffa.mjs
// Edit the layout here, not in the JSON. Units are metres, Y up; `box(id, cx, cz, w, d, h)`
// puts a box on the floor, `at(id, [cx, cy, cz], [w, h, d])` places it anywhere.
//
// A 60 x 60 m ring around a raised centre. Each side has a different lane:
//   north: two tall parallel walls close together (wall-run and wall-jump corridor)
//   south: a low tunnel (slide) with a roof to run over
//   west:  a tall climbable tower, a mantle wall and a raised ledge
//   east:  two raised platforms with a gap to dash or double-jump across, with ramps up
// The centre is a 3 m platform with a ramp each side, two climbable pillars and low cover.
// Eight spawn pads sit around the edge, out of sight of the centre.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HALF = 30; // the arena is 60 x 60
const WALL_H = 16; // perimeter walls: tall enough that wall jumps cannot be used to climb out

const boxes = [];
const ramps = [];

const at = (id, pos, size, extra = {}) => boxes.push({ id, pos, size, ...extra });
const box = (id, cx, cz, w, d, h, extra = {}) => at(id, [cx, h / 2, cz], [w, h, d], extra);
const ramp = (id, cx, cz, w, d, h, rises) =>
  ramps.push({ id, pos: [cx, h / 2, cz], size: [w, h, d], rises });

// Floor and perimeter.
at("floor", [0, -0.5, 0], [HALF * 2 + 2, 1, HALF * 2 + 2]);
at("wall-n", [0, WALL_H / 2, -HALF - 0.5], [HALF * 2 + 2, WALL_H, 1]);
at("wall-s", [0, WALL_H / 2, HALF + 0.5], [HALF * 2 + 2, WALL_H, 1]);
at("wall-w", [-HALF - 0.5, WALL_H / 2, 0], [1, WALL_H, HALF * 2]);
at("wall-e", [HALF + 0.5, WALL_H / 2, 0], [1, WALL_H, HALF * 2]);

// Centre hill: a 3 m platform, a ramp up on the north and south sides, climbable pillars on the
// east and west sides, and low cover on top.
box("hill", 0, 0, 12, 12, 3);
ramp("hill-ramp-n", 0, -10, 6, 8, 3, "+z");
ramp("hill-ramp-s", 0, 10, 6, 8, 3, "-z");
box("hill-pillar-w", -8.5, 0, 3, 6, 6, { climbable: true });
box("hill-pillar-e", 8.5, 0, 3, 6, 6, { climbable: true });
at("hill-cover", [0, 3.5, 0], [4, 1, 1.2]);

// North lane: a corridor between two 10 m walls, 4 m apart, for wall running and kicking across.
box("run-wall-w", -2.5, -19, 1, 14, 10);
box("run-wall-e", 2.5, -19, 1, 14, 10);
box("run-crate-a", -9, -22, 2, 2, 1.2);
box("run-crate-b", 9, -16, 2, 2, 1.2);

// South lane: a low tunnel you slide through (1.3 m clear), with a roof you can run over.
box("tunnel-wall-w", -2.5, 19, 1, 10, 1.3);
box("tunnel-wall-e", 2.5, 19, 1, 10, 1.3);
at("tunnel-roof", [0, 1.55, 19], [6, 0.5, 10]);
box("tunnel-crate-a", -9, 22, 2, 2, 1.2);
box("tunnel-crate-b", 9, 15, 3, 1, 2);

// West lane: a tall climbable tower, a 2 m wall to mantle, and a raised ledge to jump to.
box("tower", -20, 6, 4, 4, 10, { climbable: true });
box("mantle-wall", -14, 8, 1, 8, 2);
box("ledge", -24, -9, 6, 8, 4);
box("ledge-step", -19, -9, 3, 4, 2);
box("west-crate", -13, -6, 2, 2, 1.2);

// East lane: two 3 m platforms 8 m apart (dash or double-jump across), with a ramp up to each.
box("plat-n", 14, -8, 6, 8, 3);
box("plat-s", 14, 8, 6, 8, 3);
ramp("plat-ramp-n", 20, -8, 6, 8, 3, "-x");
ramp("plat-ramp-s", 20, 8, 6, 8, 3, "-x");
box("east-crate", 24, 0, 2, 2, 1.2);

// Cover in the open between the lanes, so a fight is never more than a couple of steps from it.
box("cover-a", -10, -12, 3, 1, 2);
box("cover-b", 10, -26, 1, 3, 2);
box("cover-c", -10, 14, 1, 3, 2);
box("cover-d", 6, 26, 3, 1, 2);
box("cover-e", -6, -27, 2, 2, 1.2);
box("cover-f", -26, 14, 2, 2, 1.2);
box("cover-g", 26, -16, 2, 2, 1.2);
box("cover-h", 26, 18, 3, 1, 2);

// Eight spawn pads: four corners, four mid-edge.
const pad = (id, x, z, s = 6) => ({ id, pos: [x, 0, z], size: [s, 1, s] });
const spawnZones = [
  pad("spawn-nw", -24, -24),
  pad("spawn-ne", 24, -24),
  pad("spawn-sw", -24, 24),
  pad("spawn-se", 24, 24),
  pad("spawn-n", 0, -27, 4),
  pad("spawn-s", 0, 27, 4),
  pad("spawn-w", -27, 0, 4),
  pad("spawn-e", 27, 0, 4),
];

const level = {
  name: "ffa",
  version: 1,
  bounds: { min: [-HALF, -5, -HALF], max: [HALF, 30, HALF] },
  boxes,
  ramps,
  controlPoints: [],
  spawnZones,
  targets: [],
};

const out = fileURLToPath(new URL("./ffa.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(level, null, 2)}\n`);
console.log(`wrote ${out}: ${boxes.length} boxes, ${ramps.length} ramps, ${spawnZones.length} spawns`);
