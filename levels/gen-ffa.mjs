// Generates levels/ffa.json, the FFA map (unnamed, greybox). Run: node levels/gen-ffa.mjs
// Edit the layout here, not in the JSON. Units are metres, Y up; north is -Z, east is +X.
// `span(id, [x0, x1], [y0, y1], [z0, z1])` makes a box from its extents; `block` stands one on the ground.
//
// A 60 x 60 m arena on three heights, cut into rooms and lanes by buildings:
//   pit (-3 m):    a 20 x 20 m sunken square in the middle, under a cross of bridges. Out by two
//                  ramps (north-east, south-west), a tunnel to the west, or by climbing and mantling.
//   ground (0 m):  the ring around the pit, with a building in each corner and an arcade under the deck.
//   high (4-7 m):  a loop around the map: north deck, east deck, the building roofs, the west
//                  catwalks and the south gantry, with gaps to jump, dash or mantle across.
// The centre is three storeys: the pit, the bridges, and the crown (a platform on climbable pillars).
// Corners: north-west a block with a passage through it, north-east two tall walls to wall run
// between, south-east a block with a slide tunnel, south-west a room with two doors.
// Eight spawn pads sit under cover around the edge.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HALF = 30; // the arena is 60 x 60
const WALL_H = 26; // perimeter walls: far above anything you can reach from the 7 m roofs with wall jumps and a mantle
const PIT = 10; // the pit is the square |x|, |z| <= PIT
const PIT_Y = -3;
const DECK_Y = 4; // the north and east decks
const CAT_Y = 5; // the west catwalks and the south gantry
const E = HALF + 1; // the shell reaches one metre past the arena

const boxes = [];
const ramps = [];

const span = (id, [x0, x1], [y0, y1], [z0, z1], extra = {}) =>
  boxes.push({
    id,
    pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
    size: [x1 - x0, y1 - y0, z1 - z0],
    ...extra,
  });
const block = (id, xs, zs, h, extra = {}) => span(id, xs, [0, h], zs, extra);
const ramp = (id, [x0, x1], [y0, y1], [z0, z1], rises) =>
  ramps.push({
    id,
    pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
    size: [x1 - x0, y1 - y0, z1 - z0],
    rises,
  });
const climb = { climbable: true };

// --- Shell: a base under everything, the ground as slabs around the pit and the tunnel trench.
span("floor-base", [-E, E], [PIT_Y - 1, PIT_Y], [-E, E]);
span("floor-n", [-E, E], [PIT_Y, 0], [-E, -PIT]);
span("floor-s", [-E, E], [PIT_Y, 0], [PIT, E]);
span("floor-e", [PIT, E], [PIT_Y, 0], [-PIT, PIT]);
span("floor-w-n", [-E, -PIT], [PIT_Y, 0], [-PIT, -1.5]);
span("floor-w-s", [-E, -PIT], [PIT_Y, 0], [1.5, PIT]);
span("floor-w-end", [-E, -24], [PIT_Y, 0], [-1.5, 1.5]);
span("wall-n", [-E, E], [0, WALL_H], [-E, -HALF]);
span("wall-s", [-E, E], [0, WALL_H], [HALF, E]);
span("wall-w", [-E, -HALF], [0, WALL_H], [-HALF, HALF]);
span("wall-e", [HALF, E], [0, WALL_H], [-HALF, HALF]);

// --- Centre: bridges across the pit at ground level, and the crown above where they cross.
span("bridge-ns", [-2, 2], [-0.5, 0], [-PIT, PIT]);
span("bridge-w", [-PIT, -2], [-0.5, 0], [-2, 2]);
span("bridge-e", [2, PIT], [-0.5, 0], [-2, 2]);
for (const [name, sx, sz] of [
  ["nw", -1, -1],
  ["ne", 1, -1],
  ["sw", -1, 1],
  ["se", 1, 1],
]) {
  // The pillars stand on the pit floor and can be climbed all the way from the pit to the crown:
  // they are its corners and end level with its top, so nothing overhangs the climb.
  const xs = sx < 0 ? [-3, -2] : [2, 3];
  const zs = sz < 0 ? [-3, -2] : [2, 3];
  span(`crown-pillar-${name}`, xs, [PIT_Y, 3.5], zs, climb);
}
span("crown", [-2, 2], [3, 3.5], [-3, 3]);
span("crown-w", [-3, -2], [3, 3.5], [-2, 2]);
span("crown-e", [2, 3], [3, 3.5], [-2, 2]);
span("crown-cover", [-2, 2], [3.5, 4.5], [-0.5, 0.5]);
// A column where the bridges cross: no straight line of sight through the middle.
block("crown-column", [-0.8, 0.8], [-0.8, 0.8], 3);
// Raised kerbs around the pit (a mantle up, 2 m deep): from the ground you cannot see across the
// pit, only along the bridges. They stop where the bridges and the two pit ramps come out, and
// stand a metre back from the edge: that ledge is where you land when you mantle out of the pit.
const RIM = 2.2;
const [R0, R1] = [PIT + 1, PIT + 3];
block("rim-n-w", [-PIT, -3], [-R1, -R0], RIM);
block("rim-n-e", [3, PIT], [-R1, -R0], RIM);
block("rim-s-w", [-PIT, -3], [R0, R1], RIM);
block("rim-s-e", [3, PIT], [R0, R1], RIM);
block("rim-e-n", [R0, R1], [-6, -3], RIM);
block("rim-e-s", [R0, R1], [3, PIT], RIM);
block("rim-w-n", [-R1, -R0], [-PIT, -3], RIM);
block("rim-w-s", [-R1, -R0], [3, 6], RIM);

// Ways out of the pit: a ramp in the north-east and south-west quarters, and a tunnel west that
// comes up a ramp in an open trench.
ramp("pit-ramp-ne", [2, PIT], [PIT_Y, 0], [-PIT, -7], "+x");
ramp("pit-ramp-sw", [-PIT, -2], [PIT_Y, 0], [7, PIT], "-x");
span("tunnel-roof", [-16, -PIT], [-0.5, 0], [-1.5, 1.5]);
ramp("tunnel-ramp", [-24, -16], [PIT_Y, 0], [-1.5, 1.5], "-x");
// Cover down in the pit.
span("pit-crate-nw", [-8, -6], [PIT_Y, PIT_Y + 1.2], [-8, -6]);
span("pit-wall-nw", [-6, -5], [PIT_Y, PIT_Y + 2], [-5, -2.5]);
span("pit-crate-se", [6, 8], [PIT_Y, PIT_Y + 1.2], [6, 8]);
span("pit-wall-se", [5, 6], [PIT_Y, PIT_Y + 2], [2.5, 5]);
span("pit-crate-ne", [5, 7], [PIT_Y, PIT_Y + 1.2], [-5, -3]);
span("pit-crate-sw", [-7, -5], [PIT_Y, PIT_Y + 1.2], [3, 5]);

// --- North and east decks: an L-shaped slab on posts, an arcade underneath, a ramp at each end.
span("deck-n", [-12, HALF], [DECK_Y - 0.5, DECK_Y], [-HALF, -24]);
span("deck-e", [24, HALF], [DECK_Y - 0.5, DECK_Y], [-24, 12]);
// The north deck reaches over the lane to the north-west block: a mantle up onto its roof.
span("deck-link", [-18, -12], [DECK_Y - 0.5, DECK_Y], [-26, -22]);
// The ramp keeps a metre clear of the link: a ramp lifts you without checking for a ceiling, so
// nothing may hang over the edge of one.
ramp("deck-ramp-nw", [-22, -12], [0, DECK_Y], [-HALF, -27], "+x");
ramp("deck-ramp-se", [26, HALF], [0, DECK_Y], [12, 22], "-z");
for (const x of [-12, 12, 20]) block(`deck-post-n${x}`, [x, x + 1], [-25, -24], DECK_Y - 0.5);
for (const z of [-16, -8, 11]) block(`deck-post-e${z}`, [24, 25], [z, z + 1], DECK_Y - 0.5);
// Walls closing parts of the arcade: they shelter the spawns under the deck.
block("arcade-wall-n", [-5, 5], [-25, -24], DECK_Y - 0.5);
block("arcade-wall-e", [24, 25], [-4, 4], DECK_Y - 0.5);
block("arcade-wall-ne", [22, 24], [-25, -24], DECK_Y - 0.5);
span("deck-cover-n", [2, 6], [DECK_Y, DECK_Y + 1.2], [-27, -26]);
span("deck-cover-e", [26, 27], [DECK_Y, DECK_Y + 1.2], [-12, -8]);
span("deck-cover-ne", [26, 28], [DECK_Y, DECK_Y + 2], [-28, -26]);

// --- North-west: a block with a passage through it (east-west).
block("nw-block-n", [-26, -16], [-22, -19.5], 6);
block("nw-block-s", [-26, -16], [-16.5, -14], 6);
span("nw-block-roof", [-26, -16], [3, 6], [-19.5, -16.5]);
span("nw-roof-cover", [-22, -20], [6, 7.2], [-19, -17]);

// --- North-east: two 10 m walls, 4 m apart, for wall running and kicking across.
block("run-wall-w", [13.5, 14.5], [-21, -11], 10);
block("run-wall-e", [18.5, 19.5], [-21, -11], 10);

// --- East: a platform between the crown and the east deck (a jump each way).
block("east-plat", [13, 18], [-3, 3], 3);

// --- South-east: a block with a low tunnel through it (north-south) that you slide through.
block("se-block-w", [10, 13.5], [16, 24], 6);
block("se-block-e", [16.5, 20], [16, 24], 6);
span("se-block-top", [13.5, 16.5], [1.4, 6], [16, 24]);
span("se-roof-cover", [11, 12], [6, 7.2], [18, 22]);

// --- South-west: a room with a door north and a door east, and a roof you can climb to.
// The walls go all the way up and the roof sits inside them, so a wall top is one clean edge to mantle.
const ROOM_H = 7;
block("room-wall-w", [-26, -25], [12, 22], ROOM_H);
block("room-wall-s", [-25, -16], [21, 22], ROOM_H);
block("room-wall-n-a", [-25, -22], [12, 13], ROOM_H);
block("room-wall-n-b", [-19.5, -16], [12, 13], ROOM_H);
span("room-lintel-n", [-22, -19.5], [2.6, ROOM_H], [12, 13]);
block("room-wall-e-a", [-17, -16], [13, 14], ROOM_H);
block("room-wall-e-b", [-17, -16], [17, 21], ROOM_H, climb);
span("room-lintel-e", [-17, -16], [2.6, ROOM_H], [14, 17]);
span("room-roof", [-25, -17], [ROOM_H - 0.5, ROOM_H], [13, 21]);
span("room-roof-cover", [-22, -18], [ROOM_H, ROOM_H + 1.2], [16, 17]);
block("room-crate", [-25, -23.5], [19.5, 21], 1.2);

// --- West: catwalks along the wall joining the two west buildings, with a gap over the trench.
span("catwalk-n", [-HALF, -26], [CAT_Y - 0.5, CAT_Y], [-22, -3]);
span("catwalk-s", [-HALF, -26], [CAT_Y - 0.5, CAT_Y], [3, 22]);
block("catwalk-post", [-26, -25], [-5, -3], CAT_Y, climb);

// --- South: a gantry over the lane, from the room's roof toward the south-east block.
span("gantry", [-12, 6], [CAT_Y, CAT_Y + 0.5], [20, 23]);
// The climbable post stands beside the gantry, level with its top, so the climb ends on the walkway.
block("gantry-post-w", [-8, -7], [23, 24], CAT_Y + 0.5, climb);
block("gantry-post-e", [1, 2], [21, 22], CAT_Y);

// --- Mid-height blocks in the open stretches of the ring (3.5 m: a jump and a mantle to get on
// top), and lower walls and crates, so a fight is never more than a couple of steps from cover.
block("north-block", [-8, 0], [-21, -15], 3.5);
block("west-block", [-22, -17], [-11, -5], 3.5);
block("south-block", [-9, -3], [13, 18], 3.5);
block("east-block", [19, 22], [5, 10], 3.5);
block("north-crate", [4, 6], [-16, -14], 1.2);
block("north-wall", [7, 8], [-21, -15], 2.2);
block("west-wall", [-15, -14], [-9, -4], 2.2);
block("west-crate", [-20, -18], [5, 7], 1.2);
block("west-wall-s", [-15, -14], [5, 10], 2.2);
block("south-wall", [-3, 3], [23.5, 24.5], 2.5);
block("south-wall-e", [4, 5], [13, 18], 2.2);
block("se-wall", [22, 23], [23, 28], 2.5);
block("se-crate", [22, 24], [16, 18], 1.2);
block("east-wall", [20, 21], [-9, -5], 2.2);
block("sw-wall", [-22, -18], [25, 26], 2.5);

// Eight spawn pads around the edge, each behind or under something.
const pad = (id, x, z, s = 4) => ({ id, pos: [x, 0, z], size: [s, 1, s] });
const spawnZones = [
  pad("spawn-nw", -27, -26),
  pad("spawn-ne", 27, -27),
  pad("spawn-sw", -21, 18),
  pad("spawn-se", 26, 26),
  pad("spawn-n", 0, -27),
  pad("spawn-s", 0, 27),
  pad("spawn-w", -28, 9),
  pad("spawn-e", 27, 0),
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
