// Generates levels/ffa.json, the FFA map (unnamed, greybox). Run: node levels/gen-ffa.mjs
// Edit the layout here, not in the JSON. Units are metres, Y up; north is -Z, east is +X.
// `span(id, [x0, x1], [y0, y1], [z0, z1])` makes a box from its extents; `block` stands one on the ground.
//
// A 200 x 200 m arena: a centre district and eight districts around it on a 3 x 3 grid, with
// 8 m avenues between them and a ring road inside the perimeter wall.
//   centre:      three heights. A sunken pit (-3 m) under a cross of bridges with the crown on
//                top; a ground ring with a building in each corner; a high loop of decks, roofs,
//                catwalks and a gantry (4 to 7 m).
//   spires:      six open towers 30 m tall: one north and one south of the pit, and one in the
//                middle of each corner district. Skybridges 26.5 m up join them all: a ring
//                round the four corners, and a spine from its north side to its south through
//                the two centre spires. The high ground, and a long way to fall.
//   corners:     "blocks" (north-west, south-east): four buildings on streets, one a room, one
//                with a passage, a skybridge between two roofs.
//                "yard" (north-east, south-west): staggered rows of containers, some stacked,
//                under a crane.
//   sides:       "basin" (north, south): a sunken basin with islands, ramps and a bridge.
//                "terraces" (west, east): three stepped terraces, a 16 m tower and a wall-run alley.
//   avenues:     gates (a walkway at 5 m over a wall) join the districts' high routes and break
//                the long views down the avenues; pillars stand where avenues cross.
// Each outer district is written once in its own coordinates and placed twice, the second time
// mirrored, so opposite sides of the map are not copies you can navigate by habit.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HALF = 100; // the arena is 200 x 200
const CORE = 30; // the centre district is the 60 x 60 in the middle
const PITCH = 66; // distance between district centres
const WALL_H = 26; // perimeter walls: far above anything you can reach from the roofs with wall jumps and a mantle
const PIT = 10; // the pit is the square |x|, |z| <= PIT
const PIT_Y = -3;
const DECK_Y = 4; // the north and east decks
const CAT_Y = 5; // the catwalks, the gantry and the gates
const E = HALF + 1; // the shell reaches one metre past the arena

const boxes = [];
const ramps = [];
const holes = []; // rectangles cut out of the ground, down to PIT_Y
const spawnZones = [];

// Where the pieces being added go: an offset, an optional mirror on each axis, and an id prefix.
let at = { ox: 0, oz: 0, fx: 1, fz: 1, pre: "" };
const tx = ([a, b]) =>
  [at.ox + at.fx * a, at.ox + at.fx * b].sort((p, q) => p - q);
const tz = ([a, b]) =>
  [at.oz + at.fz * a, at.oz + at.fz * b].sort((p, q) => p - q);
const FLIP = { "+x": "-x", "-x": "+x", "+z": "-z", "-z": "+z" };
const shape = (xs, [y0, y1], zs) => {
  const [x0, x1] = tx(xs);
  const [z0, z1] = tz(zs);
  return {
    pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
    size: [x1 - x0, y1 - y0, z1 - z0],
  };
};
/**
 * How a piece is drawn (the client's levelRender.ts; the server ignores both): `surface` is which
 * generated textures it gets, `glow` where it carries a SIGNAL light strip ("edges": along its
 * long top edges, a walkway; "door-x" or "door-z": along the bottom of its faces across X or Z,
 * the head of a doorway or passage that runs that way). Decided here from the piece's own name
 * (without the district prefix), first match wins. Looks only: nothing here changes the shapes.
 */
const SURFACES = [
  [/^floor-base$/, "pit"],
  [/^floor-\d+$/, "ground"],
  [/crate|cover/, "crate"],
  [/^box-\d+$/, "container"],
  [/post|pillar|column|leg|^cross-/, "pillar"],
  [/step/, "concrete"],
  [/^gate-\d+-wall$/, "barrier"],
  [/^(deck|catwalk|gantry|gate|skybridge|crane-beam|bridge|crown|tunnel-roof|spire|sky-)/, "metal"],
  [/^(rim|kerb)-/, "stripe"],
  [/^room|^tower$/, "panel"],
  [/^(run-wall|alley)-/, "panel"],
  [/wall/, "barrier"],
];
const WALKWAY =
  /^(deck-[ne]|deck-link|catwalk-[ns]|gantry|gate-\d+|skybridge|crane-beam|bridge(-\w+)?|crown(-[we])?|spire-\w+-floor-\d|sky-[a-z-]+)$/;
const DOORS = {
  "room-lintel-n": "door-z",
  "room-lintel-e": "door-x",
  "pass-roof": "door-x",
  "nw-block-roof": "door-x",
  "se-block-top": "door-z",
  "hall-n-top": "door-z",
  "hall-s-top": "door-z",
  "tunnel-roof": "door-x",
};
const look = (id, glow) => {
  // (The perimeter is the only "wall-n/s/w/e" outside a district: the districts' are low walls.)
  const perimeter = at.pre === "" && /^wall-[nswe]$/.test(id);
  let surface = perimeter
    ? "panel"
    : (SURFACES.find(([re]) => re.test(id))?.[1] ?? "concrete");
  // Every other container is the light kind, so a yard is not one colour.
  if (surface === "container" && (Number(id.at(-1)) + Number(id.at(-2))) % 2)
    surface = "container-light";
  const g = glow ?? DOORS[id] ?? (WALKWAY.test(id) ? "edges" : undefined);
  return g ? { surface, glow: g } : { surface };
};
const span = (id, xs, ys, zs, glow) =>
  boxes.push({ id: at.pre + id, ...shape(xs, ys, zs), ...look(id, glow) });
const block = (id, xs, zs, h) => span(id, xs, [0, h], zs);
const ramp = (id, xs, ys, zs, rises) => {
  const flipped = (rises[1] === "x" ? at.fx : at.fz) < 0;
  ramps.push({
    id: at.pre + id,
    ...shape(xs, ys, zs),
    rises: flipped ? FLIP[rises] : rises,
    surface: "ramp",
  });
};
const hole = (xs, zs) => holes.push({ x: tx(xs), z: tz(zs) });
const spawn = (id, x, z) =>
  spawnZones.push({
    id: `spawn-${at.pre}${id}`,
    pos: [at.ox + at.fx * x, 0, at.oz + at.fz * z],
    size: [4, 1, 4],
  });
/** Add a district: `build` runs with everything it adds moved to (ox, oz) and mirrored by fx, fz. */
const place = (pre, ox, oz, fx, fz, build) => {
  at = { ox, oz, fx, fz, pre: `${pre}-` };
  build();
  at = { ox: 0, oz: 0, fx: 1, fz: 1, pre: "" };
};

/**
 * A hollow room: 1 m walls all the way up with the roof set inside them (so a wall top is one
 * clean edge to mantle). `doors` are gaps 2.6 m tall: { side: "n" | "s" | "w" | "e", at: [a, b] }
 * along that wall.
 */
const room = (id, [x0, x1], [z0, z1], h, doors) => {
  const wall = (name, side, fixed, [a, b]) => {
    const along = side === "n" || side === "s";
    // (The piece over a door carries a light strip: a wall along X is walked through along Z.)
    const piece = (n, [p, q], ys, door) =>
      along
        ? span(`${id}-${name}${n}`, [p, q], ys, fixed, door && "door-z")
        : span(`${id}-${name}${n}`, fixed, ys, [p, q], door && "door-x");
    let from = a;
    let n = 0;
    for (const d of doors
      .filter((d) => d.side === side)
      .sort((p, q) => p.at[0] - q.at[0])) {
      if (d.at[0] > from) piece(n++, [from, d.at[0]], [0, h]);
      piece(n++, d.at, [2.6, h], true);
      from = d.at[1];
    }
    if (b > from) piece(n, [from, b], [0, h]);
  };
  wall("n", "n", [z0, z0 + 1], [x0, x1]);
  wall("s", "s", [z1 - 1, z1], [x0, x1]);
  wall("w", "w", [x0, x0 + 1], [z0 + 1, z1 - 1]);
  wall("e", "e", [x1 - 1, x1], [z0 + 1, z1 - 1]);
  span(`${id}-roof`, [x0 + 1, x1 - 1], [h - 0.5, h], [z0 + 1, z1 - 1]);
};

// --- Perimeter.
span("wall-n", [-E, E], [0, WALL_H], [-E, -HALF]);
span("wall-s", [-E, E], [0, WALL_H], [HALF, E]);
span("wall-w", [-E, -HALF], [0, WALL_H], [-HALF, HALF]);
span("wall-e", [HALF, E], [0, WALL_H], [-HALF, HALF]);

// ============================== Centre district ==============================
hole([-PIT, PIT], [-PIT, PIT]); // the pit
hole([-24, -PIT], [-1.5, 1.5]); // the tunnel and its trench

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
  // The pillars stand on the pit floor and are the crown's corners, level with its top: from a
  // bridge, jump at one and mantle to get onto the crown.
  const xs = sx < 0 ? [-3, -2] : [2, 3];
  const zs = sz < 0 ? [-3, -2] : [2, 3];
  span(`crown-pillar-${name}`, xs, [PIT_Y, 3.5], zs);
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
span("deck-n", [-12, CORE], [DECK_Y - 0.5, DECK_Y], [-CORE, -24]);
span("deck-e", [24, CORE], [DECK_Y - 0.5, DECK_Y], [-24, 12]);
// The north deck reaches over the lane to the north-west block: a mantle up onto its roof.
span("deck-link", [-18, -12], [DECK_Y - 0.5, DECK_Y], [-26, -22]);
// The ramp keeps a metre clear of the link: a ramp lifts you without checking for a ceiling, so
// nothing may hang over the edge of one.
ramp("deck-ramp-nw", [-22, -12], [0, DECK_Y], [-CORE, -27], "+x");
ramp("deck-ramp-se", [26, CORE], [0, DECK_Y], [12, 22], "-z");
for (const x of [-12, 12, 20])
  block(`deck-post-n${x}`, [x, x + 1], [-25, -24], DECK_Y - 0.5);
for (const z of [-16, -8, 11])
  block(`deck-post-e${z}`, [24, 25], [z, z + 1], DECK_Y - 0.5);
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

// --- South-west: a room with a door north and a door east, and a roof reached from the catwalk.
// The walls go all the way up and the roof sits inside them, so a wall top is one clean edge to mantle.
const ROOM_H = 7;
block("room-wall-w", [-26, -25], [12, 22], ROOM_H);
block("room-wall-s", [-25, -16], [21, 22], ROOM_H);
block("room-wall-n-a", [-25, -22], [12, 13], ROOM_H);
block("room-wall-n-b", [-19.5, -16], [12, 13], ROOM_H);
span("room-lintel-n", [-22, -19.5], [2.6, ROOM_H], [12, 13]);
block("room-wall-e-a", [-17, -16], [13, 14], ROOM_H);
block("room-wall-e-b", [-17, -16], [17, 21], ROOM_H);
span("room-lintel-e", [-17, -16], [2.6, ROOM_H], [14, 17]);
span("room-roof", [-25, -17], [ROOM_H - 0.5, ROOM_H], [13, 21]);
span("room-roof-cover", [-22, -18], [ROOM_H, ROOM_H + 1.2], [16, 17]);
block("room-crate", [-25, -23.5], [19.5, 21], 1.2);

// --- West: catwalks on posts joining the two west buildings, with a gap over the trench.
span("catwalk-n", [-CORE, -26], [CAT_Y - 0.5, CAT_Y], [-22, -3]);
span("catwalk-s", [-CORE, -26], [CAT_Y - 0.5, CAT_Y], [3, 22]);
for (const z of [-22, -13, 12, 21])
  block(`catwalk-post${z}`, [-CORE, -29], [z, z + 1], CAT_Y - 0.5);
// A step beside the catwalk: mantle onto it, then jump and mantle onto the catwalk.
block("catwalk-step", [-26, -24], [-5, -3], 2.5);

// --- South: a gantry over the lane, from the room's roof toward the south-east block.
span("gantry", [-12, 6], [CAT_Y, CAT_Y + 0.5], [20, 23]);
// A step beside the gantry: mantle onto it, then jump and mantle onto the gantry.
block("gantry-step", [-9, -6], [23, 25], 3);
block("gantry-post-e", [1, 2], [21, 22], CAT_Y);

// --- Mid-height blocks in the open stretches of the ring (3.5 m: a jump and a mantle to get on
// top), and lower walls and crates, so a fight is never more than a couple of steps from cover.
block("west-block", [-22, -17], [-11, -5], 3.5);
block("east-block", [19, 22], [5, 10], 3.5);
block("north-crate", [9, 11], [-16, -14], 1.2);
block("north-wall", [7, 8], [-21, -15], 2.2);
block("west-wall", [-15, -14], [-9, -4], 2.2);
block("west-crate", [-20, -18], [5, 7], 1.2);
block("west-wall-s", [-15, -14], [5, 10], 2.2);
block("south-wall", [-3, 3], [23.5, 24.5], 2.5);
block("south-wall-e", [6, 7], [13, 18], 2.2);
block("se-wall", [22, 23], [23, 28], 2.5);
block("se-crate", [22, 24], [16, 18], 1.2);
block("east-wall", [20, 21], [-9, -5], 2.2);
block("sw-wall", [-22, -18], [25, 26], 2.5);

// --- The spires: open towers 30 m tall. Two stand north and south of the pit (where the north
// and south blocks stood); one stands in the middle of each corner district (see blocks and
// yard). Each is on four legs with nothing between them at ground level, so you walk straight
// under it. Above, half-floors alternate west and east every 3.5 m, and under the inner edge of
// each hangs a wall down to the level of the floor below on the other side: stand on that floor,
// jump against the wall, and the mantle puts you on the next (a 3.5 m climb, like the blocks in
// the ring; one jump is enough). The walls also stop you walking off the inner edge. A step
// beside each gets you up from the ground. The top is 30 m: the drop the rolling dive wants for
// its one-hit kill. The seventh floor, 26.5 m up, is the one the skybridges are on.
const SPIRE_FLOORS = [5.5, 9, 12.5, 16, 19.5, 23, 26.5, 30];
const SKY = 6; // the floor the skybridges are on
const SKY_Y = SPIRE_FLOORS[SKY];
const ordered = (a, b) => [a, b].sort((p, q) => p - q);
/** Where each spire's skybridge floor is, in world coordinates: the bridges are built to meet it. */
const spires = {};
/** A spire `name` centred on (0, cz) in the current district's coordinates. */
function spire(name, cz) {
  const zs = [cz - 3, cz + 3];
  for (const [lx, lz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const x0 = lx < 0 ? -5 : 4;
    const z0 = lz < 0 ? zs[0] : zs[1] - 1;
    block(
      `spire-${name}-leg-${lz < 0 ? "n" : "s"}${lx < 0 ? "w" : "e"}`,
      [x0, x0 + 1],
      [z0, z0 + 1],
      SPIRE_FLOORS.at(-1) + 0.5,
    );
  }
  SPIRE_FLOORS.forEach((y, i) => {
    span(`spire-${name}-floor-${i}`, i % 2 === 0 ? [-4, 0] : [0, 4], [y - 0.5, y], zs);
    if (i > 0)
      span(
        `spire-${name}-wall-${i}`,
        i % 2 === 0 ? [-0.3, 0] : [0, 0.3],
        [SPIRE_FLOORS[i - 1], y - 0.5],
        zs,
      );
  });
  // Cover on the top, and on the skybridge floor.
  const top = SPIRE_FLOORS.at(-1);
  span(`spire-${name}-cover-top`, [1, 3], [top, top + 1.2], [cz - 0.5, cz + 0.5]);
  span(`spire-${name}-cover-mid`, [-3.5, -2.5], [SKY_Y, SKY_Y + 1.2], [cz - 2, cz + 2]);
  block(`spire-${name}-step`, [-7.5, -5], [cz - 1.5, cz + 1.5], 3);
  spires[name] = {
    x: at.ox,
    z: tz([cz, cz])[0],
    floor: tx(SKY % 2 === 0 ? [-4, 0] : [0, 4]), // the skybridge floor's extent along X
    depth: tz(zs),
  };
}
spire("n", -17);
spire("s", 17);

// The centre's own spawn pads, each behind or under something.
spawn("nw", -27, -26);
spawn("ne", 27, -27);
spawn("sw", -21, 18);
spawn("se", 26, 26);
spawn("n", 0, -27);
spawn("s", 0, 27);
spawn("w", -28, 9);
spawn("e", 27, 0);

// ============================== Outer districts ==============================
// Each is drawn inside |x|, |z| <= 28 of its own centre.

/** Four buildings on streets: a block with a passage, a room, a tall block and a low one with a ramp. */
function blocks() {
  // North-west: a block with an east-west passage through it.
  block("pass-n", [-26, -8], [-26, -20], 7);
  block("pass-s", [-26, -8], [-16, -10], 7);
  span("pass-roof", [-26, -8], [3, 7], [-20, -16]);
  span("pass-cover", [-20, -16], [7, 8.2], [-25, -24]);
  // North-east: a room with a door south and a door west.
  room("room", [6, 24], [-26, -10], 6, [
    { side: "s", at: [13, 16] },
    { side: "w", at: [-20, -17] },
  ]);
  block("room-crate", [19, 21], [-24, -22], 1.2);
  // A skybridge from the passage block's roof (7 m) down to the room's (6 m).
  span("skybridge", [-8, 6], [5.5, 6], [-15, -12]);
  // South-west: a tall block (9 m) with a 3 m ledge along its east side.
  block("tall", [-26, -10], [6, 26], 9);
  block("tall-ledge", [-10, -6], [10, 22], 3);
  // South-east: a low building (4 m) with a ramp up its west side.
  block("low", [6, 26], [8, 26], 4);
  ramp("low-ramp", [-2, 6], [0, 4], [20, 26], "+x");
  span("low-cover", [14, 18], [4, 5.2], [16, 17]);
  // Street cover.
  block("crate-a", [-2, 0], [-4, -2], 1.2);
  block("wall-a", [-10, -9], [-2, 6], 2.2);
  block("crate-b", [14, 16], [-2, 0], 1.2);
  block("wall-b", [0, 6], [6, 7], 2.2);
  block("crate-c", [-22, -20], [-3, -1], 1.2);
  spawn("room", 15, -19);
  // A spire where the streets cross (the two walls above stand clear of its legs and its step).
  spire(at.pre.slice(0, -1), 1.5);
  spawn("street", -2, 12);
}

/** A container yard: staggered rows of long containers, some stacked two high, under a crane. */
function yard() {
  const rows = [-25, -15, -5, 5, 15];
  rows.forEach((z, r) => {
    // Three containers a row, shifted every other row so there is no straight view across.
    const shift = r % 2 === 0 ? 0 : 7;
    [-26, -8, 10].forEach((x, c) => {
      const x0 = x + shift;
      const x1 = Math.min(27, x0 + 14);
      const h = (r + c) % 3 === 0 ? 6 : 3;
      block(`box-${r}${c}`, [x0, x1], [z, z + 3], h);
    });
  });
  // The crane: a beam 11 m up on four legs, a landmark you can see from anywhere.
  for (const [n, x, z] of [
    ["a", -24, 22],
    ["b", 22, 22],
  ])
    block(`crane-leg-${n}`, [x, x + 2], [z, z + 2], 10);
  span("crane-beam", [-24, 24], [10, 11], [22, 24]);
  block("crate-a", [-4, -2], [-10, -8], 1.2);
  block("crate-b", [4, 6], [10, 12], 1.2);
  block("wall-a", [-14, -8], [25, 26], 2.5);
  // A spire in the lane between the two middle rows.
  spire(at.pre.slice(0, -1), 1.5);
  spawn("lane", -16, 0.5);
  spawn("crane", 8, 26.5);
}

/** A sunken basin with islands, a ramp at each end, a bridge across, and a long building each side. */
function basin() {
  hole([-22, 22], [-14, 14]);
  ramp("ramp-w", [-22, -14], [PIT_Y, 0], [-14, -10], "-x");
  ramp("ramp-e", [14, 22], [PIT_Y, 0], [10, 14], "+x");
  span("bridge", [-2, 2], [-0.5, 0], [-14, 14]);
  // Islands: one level with the ground (a stepping stone between the bridge and the west bank),
  // one lower, and cover on the basin floor.
  span("island-w", [-12, -7], [PIT_Y, 0], [-3, 3]);
  span("island-e", [8, 13], [PIT_Y, -1.5], [-6, 0]);
  span("crate-w", [-18, -16], [PIT_Y, PIT_Y + 1.2], [6, 8]);
  span("crate-e", [16, 18], [PIT_Y, PIT_Y + 1.2], [-8, -6]);
  span("wall-e", [5, 6], [PIT_Y, PIT_Y + 2], [4, 10]);
  // Kerbs along the long sides, a metre back from the edge (the ledge you mantle out onto).
  block("kerb-n-w", [-12, -4], [-17, -15], 2.2);
  block("kerb-n-e", [4, 20], [-17, -15], 2.2);
  block("kerb-s-w", [-20, -4], [15, 17], 2.2);
  block("kerb-s-e", [4, 12], [15, 17], 2.2);
  // A long building on the north bank and one on the south, each with a passage through.
  block("hall-n-w", [-24, -9], [-27, -20], 5);
  block("hall-n-e", [-5, 6], [-27, -20], 5);
  span("hall-n-top", [-9, -5], [3, 5], [-27, -20]);
  block("hall-s-w", [-6, 5], [20, 27], 5);
  block("hall-s-e", [9, 24], [20, 27], 5);
  span("hall-s-top", [5, 9], [3, 5], [20, 27]);
  block("crate-n", [12, 14], [-24, -22], 1.2);
  block("wall-n", [18, 19], [-27, -20], 2.5);
  block("crate-s", [-14, -12], [22, 24], 1.2);
  block("wall-s", [-19, -18], [20, 27], 2.5);
  spawn("north", 22, -23);
  spawn("south", -23, 23);
}

/** Three stepped terraces with a ramp, a 16 m tower and an alley between two walls to wall run. */
function terraces() {
  block("step-1", [-24, 24], [-24, -8], 2);
  span("step-2", [-24, 8], [2, 4], [-24, -14]);
  span("step-3", [-24, -8], [4, 6], [-24, -19]);
  ramp("ramp", [-4, 4], [0, 2], [-8, 0], "-z");
  span("cover-1", [14, 18], [2, 3.2], [-12, -11]);
  span("cover-2", [-4, 0], [4, 5.2], [-18, -17]);
  // The tower: too tall to get onto, a landmark and a block in the long views.
  block("tower", [12, 22], [6, 16], 16);
  // The alley: two 9 m walls 4 m apart.
  block("alley-w", [-22, -21], [4, 24], 9);
  block("alley-e", [-17, -16], [4, 24], 9);
  block("mid-block", [-10, -2], [10, 16], 3.5);
  block("crate-a", [4, 6], [20, 22], 1.2);
  block("wall-a", [-12, -4], [22, 23], 2.2);
  block("wall-b", [24, 25], [-4, 4], 2.5);
  block("crate-b", [8, 10], [2, 4], 1.2);
  spawn("tower", 17, 20);
  spawn("alley", -26, 14);
}

place("nw", -PITCH, -PITCH, 1, 1, blocks);
place("se", PITCH, PITCH, -1, -1, blocks);
place("ne", PITCH, -PITCH, 1, 1, yard);
place("sw", -PITCH, PITCH, -1, -1, yard);
place("n", 0, -PITCH, 1, 1, basin);
place("s", 0, PITCH, -1, 1, basin);
place("w", -PITCH, 0, 1, 1, terraces);
place("e", PITCH, 0, -1, -1, terraces);

// ============================== Skybridges ==============================
// 26.5 m up, 3 m wide, each from one spire's seventh floor to another's: a ring round the four
// corner spires, and a spine from the middle of its north side to the middle of its south,
// through the two centre spires (which the first bridge already joins over the pit). A bridge
// that runs along X ends where the floor it meets ends, which may be half way through the spire.
// Low cover stands on alternate sides every 24 m: a bridge is a long way to be seen from.
{
  const ys = [SKY_Y - 0.5, SKY_Y];
  // `oneSide`: all the cover on the far side (the spine: its near side runs on into the spires'
  // half-floors, so that side is the way through).
  const bridge = (id, xs, zs, oneSide = false) => {
    span(id, xs, ys, zs);
    const alongX = xs[1] - xs[0] > zs[1] - zs[0];
    const [a, b] = alongX ? xs : zs;
    let n = 0;
    for (let c = a + 12; c < b - 6; c += 24, n++) {
      const side = n % 2 === 0 && !oneSide ? [0, 1] : [2, 3]; // across the 3 m width
      const across = alongX ? [zs[0] + side[0], zs[0] + side[1]] : [xs[0] + side[0], xs[0] + side[1]];
      const along = [c, c + 2];
      span(
        `${id}-cover-${n}`,
        alongX ? along : across,
        [SKY_Y, SKY_Y + 1.2],
        alongX ? across : along,
      );
    }
  };
  const { n, s, nw, ne, sw, se } = spires;
  bridge("sky-centre", [-1.5, 1.5], [n.depth[1], s.depth[0]], true);
  // The ring. (North and south run along X; west and east along Z, between the spires' faces.)
  bridge("sky-north", [nw.floor[1], ne.floor[0]], [nw.z - 1.5, nw.z + 1.5]);
  bridge("sky-south", [sw.floor[1], se.floor[0]], [sw.z - 1.5, sw.z + 1.5]);
  bridge("sky-west", [nw.x - 1.5, nw.x + 1.5], [nw.depth[1], sw.depth[0]]);
  bridge("sky-east", [ne.x - 1.5, ne.x + 1.5], [ne.depth[1], se.depth[0]]);
  // The spine: from the ring's north side to the north spire, and from the south spire on.
  bridge("sky-spine-n", [-1.5, 1.5], [nw.z + 1.5, n.depth[0]], true);
  bridge("sky-spine-s", [-1.5, 1.5], [s.depth[1], sw.z - 1.5], true);
}

// ============================== Avenues and ring road ==============================
// The avenues run at |x| or |z| from CORE to PITCH - 28. A gate is a walkway at 5 m across the
// avenue with a wall beside it across half the avenue: the walkway joins two districts' high routes, the wall
// breaks the view down the avenue (alternating sides, so you weave).
const AV0 = CORE;
const AV1 = PITCH - 28;
const AVM = (AV0 + AV1) / 2;
let gates = 0;
const gate = (alongX, c, side) => {
  // `alongX`: the avenue runs along X (so the gate spans Z); c is where along it; side is +-1.
  const n = gates++;
  const across = [side * AV0, side * AV1].sort((p, q) => p - q);
  const half =
    n % 2 === 0
      ? [across[0], AVM * side].sort((p, q) => p - q)
      : [AVM * side, across[1]].sort((p, q) => p - q);
  const depth = [c - 1.5, c + 1.5];
  // The wall stands just beside the walkway, not under it: from its top a jump and a mantle get you up.
  const beside = [c + 1.5, c + 2.5];
  if (alongX) {
    span(`gate-${n}`, depth, [CAT_Y - 0.5, CAT_Y], across);
    block(`gate-${n}-wall`, beside, half, 2.5);
  } else {
    span(`gate-${n}`, across, [CAT_Y - 0.5, CAT_Y], depth);
    block(`gate-${n}-wall`, half, beside, 2.5);
  }
};
for (const side of [-1, 1]) {
  // (-8 and 26 keep the two middle gates clear of the centre's deck ramps: nothing may overhang a ramp.)
  for (const c of [-PITCH - 16, -PITCH + 14, -8, 26, PITCH - 14, PITCH + 16]) {
    gate(true, c, side); // east-west avenues (north and south of the centre)
    gate(false, c, side); // north-south avenues (west and east of the centre)
  }
  // A pillar where two avenues cross.
  for (const other of [-1, 1])
    block(
      `cross-${side > 0 ? "e" : "w"}${other > 0 ? "s" : "n"}`,
      [side * AVM - 2, side * AVM + 2],
      [other * AVM - 2, other * AVM + 2],
      8,
    );
}
// The ring road, between the outer districts and the perimeter wall: buttresses against the
// wall and blocks on the inner side, alternating.
const RING0 = PITCH + 28;
[-80, -48, -16, 16, 48, 80].forEach((c, i) => {
  const outer = i % 2 === 0;
  const across = outer ? [HALF - 3.5, HALF] : [RING0, RING0 + 3];
  for (const s of [-1, 1]) {
    const band = [s * across[0], s * across[1]].sort((p, q) => p - q);
    const name = `${s > 0 ? "p" : "m"}${i}`;
    block(`ring-x-${name}`, [c - 3, c + 3], band, 3.5); // north and south roads
    block(`ring-z-${name}`, band, [-c - 3, -c + 3], 3.5); // west and east roads
  }
});

// ============================== Ground ==============================
// A base under everything, and the ground as slabs around the holes (pit, trench, basins).
span("floor-base", [-E, E], [PIT_Y - 1, PIT_Y], [-E, E]);
{
  const cuts = (k) =>
    [...new Set([-E, E, ...holes.flatMap((h) => h[k])])].sort((p, q) => p - q);
  const xs = cuts("x");
  const zs = cuts("z");
  const solid = (x, z) =>
    !holes.some((h) => x > h.x[0] && x < h.x[1] && z > h.z[0] && z < h.z[1]);
  // One strip per band of z, cut where a hole interrupts it; equal strips in neighbouring bands join.
  const open = new Map();
  let n = 0;
  for (let j = 0; j + 1 < zs.length; j++) {
    const zm = (zs[j] + zs[j + 1]) / 2;
    const runs = [];
    for (let i = 0; i + 1 < xs.length; i++) {
      if (!solid((xs[i] + xs[i + 1]) / 2, zm)) continue;
      const last = runs[runs.length - 1];
      if (last && last[1] === xs[i]) last[1] = xs[i + 1];
      else runs.push([xs[i], xs[i + 1]]);
    }
    const next = new Map();
    for (const run of runs) {
      const key = run.join();
      const slab = open.get(key) ?? { x: run, z: [zs[j], zs[j]] };
      slab.z[1] = zs[j + 1];
      next.set(key, slab);
    }
    for (const [key, slab] of open)
      if (!next.has(key)) span(`floor-${n++}`, slab.x, [PIT_Y, 0], slab.z);
    open.clear();
    for (const [key, slab] of next) open.set(key, slab);
  }
  for (const slab of open.values())
    span(`floor-${n++}`, slab.x, [PIT_Y, 0], slab.z);
}

// ============================== Looks only ==============================
// Everything below is drawn by the client and is in nobody's way: the server and the movement
// code never see it, and none of it can be touched. It is either thin, high up, flat on a
// surface, or outside the perimeter wall.

// --- District signs: each district has a compass code, painted on the perimeter wall behind it
// (seen over the roofs from anywhere) and on the ground of every avenue that leads into it.
const signs = [];
const DISTRICTS = [
  ["NW", -1, -1],
  ["N", 0, -1],
  ["NE", 1, -1],
  ["W", -1, 0],
  ["C", 0, 0],
  ["E", 1, 0],
  ["SW", -1, 1],
  ["S", 0, 1],
  ["SE", 1, 1],
];
for (const [code, gx, gz] of DISTRICTS) {
  const [cx, cz] = [gx * PITCH, gz * PITCH];
  // On the wall: high above the sector numbers, facing into the arena.
  if (gz !== 0)
    signs.push({
      id: `sign-wall-${code}-z`,
      text: code,
      pos: [cx, 20, gz * (HALF - 0.04)],
      size: 7,
      face: gz < 0 ? "+z" : "-z",
    });
  if (gx !== 0)
    signs.push({
      id: `sign-wall-${code}-x`,
      text: code,
      pos: [gx * (HALF - 0.04), 20, cz],
      size: 7,
      face: gx < 0 ? "+x" : "-x",
    });
  // On the ground: just outside each edge that has a neighbour, the top of the letters pointing
  // into the district, so you read it as you walk in.
  for (const [dx, dz] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ]) {
    if (Math.abs(gx + dx) > 1 || Math.abs(gz + dz) > 1) continue;
    const out = (gx === 0 && gz === 0 ? CORE : 28) + 2.2;
    signs.push({
      id: `sign-floor-${code}-${dx}${dz}`,
      text: code,
      pos: [cx + dx * out, 0.03, cz + dz * out],
      size: 2.6,
      face: "up",
      yaw: Math.atan2(dx, dz), // the letters' tops point back into the district
    });
  }
}

// --- Props.
const props = [];
const prop = (kind, id, pos, extra = {}) =>
  props.push({ id: `${kind}-${id}`, kind, pos, ...extra });
// Lamp posts in the margin at every district corner, their arms out over the crossing.
for (const [code, gx, gz] of DISTRICTS)
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const r = (gx === 0 && gz === 0 ? CORE : 28) + 0.9;
      prop("lamp", `${code}-${sx}${sz}`, [gx * PITCH + sx * r, 0, gz * PITCH + sz * r], {
        yaw: Math.atan2(sx, sz),
      });
    }
// A pair of pipes and a row of wall units round the inside of the perimeter wall.
for (const [name, face, fixed] of [
  ["n", "+z", -HALF],
  ["s", "-z", HALF],
  ["w", "+x", -HALF],
  ["e", "-x", HALF],
]) {
  const alongX = face[1] === "z";
  const at3 = (c, y) => (alongX ? [c, y, fixed] : [fixed, y, c]);
  for (const y of [9, 9.6])
    prop("pipe", `${name}-${y}`, at3(0, y), { face, size: [2 * HALF, 0.22, 0.22] });
  for (let c = -90; c <= 90; c += 20)
    if (Math.abs(Math.abs(c) - PITCH) > 6 && Math.abs(c) > 6)
      prop("unit", `${name}-${c}`, at3(c, 5.5), { face });
}
// Masts with a light on top, on the things nobody can stand on, and on the perimeter wall.
for (const [x, z] of [
  [-HALF, -HALF],
  [HALF, -HALF],
  [-HALF, HALF],
  [HALF, HALF],
  [0, -HALF],
  [0, HALF],
  [-HALF, 0],
  [HALF, 0],
])
  prop("mast", `wall-${x}-${z}`, [x * 1.005, WALL_H, z * 1.005], { size: [0.25, 8, 0.25] });
for (const [name, sp] of Object.entries(spires))
  prop("mast", `spire-${name}`, [sp.x + 4.5, 30.5, sp.depth[1] - 0.5], { size: [0.15, 5, 0.15] });
// (The terraces' tower and the yards' crane are placed twice, the second time turned round.)
for (const s of [1, -1]) {
  prop("mast", `tower-${s}`, [s * (-PITCH + 17), 16, s * 11], { size: [0.2, 6, 0.2] });
  prop("mast", `crane-${s}`, [s * PITCH, 11, s * (-PITCH + 23)], { size: [0.15, 3, 0.15] });
  // The crane's hook hangs under the middle of its beam, well above head height.
  prop("hook", `crane-${s}`, [s * (PITCH + 6), 10, s * (-PITCH + 23)], { size: [0.6, 3.6, 0.6] });
}
// The city beyond the wall: dark towers with a few lit windows, only ever seen over the top of it.
{
  let seed = 7;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const N = 30;
  for (let i = 0; i < N; i++) {
    const a = ((i + rnd() * 0.6) / N) * Math.PI * 2;
    const far = HALF * 1.45 + 30 + rnd() * 70;
    const w = 14 + rnd() * 16;
    const h = 38 + rnd() * 50;
    prop(
      "tower",
      String(i),
      [Math.round(Math.sin(a) * far), 0, Math.round(Math.cos(a) * far)],
      { size: [Math.round(w), Math.round(h), Math.round(14 + rnd() * 16)] },
    );
  }
}

const level = {
  name: "ffa",
  version: 1,
  // Looks: the FFA map is played at night (the client's sky, fog and lights; see main.ts).
  sky: "night",
  bounds: { min: [-HALF, -5, -HALF], max: [HALF, 40, HALF] },
  boxes,
  ramps,
  controlPoints: [],
  spawnZones,
  targets: [],
  signs,
  props,
};

const out = fileURLToPath(new URL("./ffa.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(level, null, 2)}\n`);
console.log(
  `wrote ${out}: ${boxes.length} boxes, ${ramps.length} ramps, ${spawnZones.length} spawns, ${signs.length} signs, ${props.length} props`,
);
