import * as THREE from "three";

import { type BodyState, CharacterBody } from "./character";
import { loadCharacterModels } from "./characterModels";
import { PALETTE } from "./palette";
import { type ReloadPose, reloadPose } from "./reloadAnim";
import { FX_MODES, type FxMode, RetroRenderer } from "./render";
import { BRICK_MAG_HOME, BRICK_MUZZLE, buildBrick } from "./rifle";
import { COMBAT, PARAMS as P, SKILL, SNIPER, SPEAR, WEAPON } from "./sim/params";
import { buildSniper, SNIPER_MUZZLE } from "./sniper";
import { buildSpear, SPEAR_MUZZLE, SPEAR_PAIR_GAP } from "./spear";

// Blockbench character models: loaded before any character is made (see characterModels.ts).
await loadCharacterModels();

/**
 * Dev-only character viewer and animation test stage (open /figure.html while `pnpm dev`
 * runs). A fake player moves back and forth using the game's real speeds, jump and gravity,
 * so every animation can be checked up close. Pick the model, animation and screen effect in
 * the panel; drag to turn the camera, scroll to zoom. Same lights as the game.
 * Not part of the game build. Visual only: this is not the real movement code.
 */

const canvas = document.getElementById("game") as HTMLCanvasElement;
const help = document.getElementById("help") as HTMLDivElement;
const modelSelect = document.getElementById("model") as HTMLSelectElement;
const animSelect = document.getElementById("anim") as HTMLSelectElement;
const weaponSelect = document.getElementById("weapon") as HTMLSelectElement;
const fxSelect = document.getElementById("fx") as HTMLSelectElement;
const replayButton = document.getElementById("replay") as HTMLButtonElement;
const hitboxCheck = document.getElementById("hitbox") as HTMLInputElement;
const aimCheck = document.getElementById("aim") as HTMLInputElement;
const fireCheck = document.getElementById("fire") as HTMLInputElement;
const panel = document.getElementById("panel") as HTMLDivElement;

/**
 * The models you can preview: characters (walk, jump, aim...) and weapons (fire, reload...).
 * Add a row when there is another one; the selector in the panel lists whatever is in this table.
 */
const MODELS = [
  { id: "trooper", name: "Trooper", kind: "character" },
  { id: "assassin", name: "Assassin", kind: "character" },
  { id: "dummy", name: "Dummy (base model)", kind: "character" },
  { id: "brick", name: "Brick (rifle)", kind: "weapon" },
  { id: "needle", name: "Needle (sniper)", kind: "weapon" },
  { id: "spears", name: "Spears (launchers)", kind: "weapon" },
] as const;

const scene = new THREE.Scene();
scene.background = PALETTE.HAZE;
scene.add(new THREE.HemisphereLight(PALETTE.BONE, PALETTE.GRAPHITE, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(20, 40, 10);
scene.add(sun);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshLambertMaterial({ color: PALETTE.CONCRETE }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

/** A wall to run along: shown only for the wall run, its face just beside the character (z = -0.35). */
const WALL_FACE_Z = -0.35;
const wall = new THREE.Mesh(
  new THREE.BoxGeometry(24, 8, 0.5),
  new THREE.MeshLambertMaterial({ color: PALETTE.BONE }),
);
wall.position.set(0, 4, WALL_FACE_Z - 0.25);
const wallStripe = new THREE.Mesh(
  new THREE.BoxGeometry(24, 0.05, 0.02),
  new THREE.MeshBasicMaterial({ color: PALETTE.SIGNAL }),
);
wallStripe.position.set(0, 1.6, WALL_FACE_Z + 0.011); // a guide line at the height of the run
wall.visible = false;
wallStripe.visible = false;
scene.add(wall, wallStripe);

let model: (typeof MODELS)[number] = MODELS[0];
/** One body per character look; `body` is the one being shown. */
const bodies = {
  trooper: new CharacterBody(scene, 0, "trooper"),
  assassin: new CharacterBody(scene, 0, "assassin"),
  dummy: new CharacterBody(scene, 0, "dummy"),
};
let body = bodies.trooper;
bodies.assassin.root.visible = false;
bodies.dummy.root.visible = false;

// The weapon preview: the rifle floating at about chest height, muzzle to the right.
const brick = buildBrick();
const needle = buildSniper();
const spears = buildSpear();
/** The weapon preview models, each with a muzzle flash and its own gun's numbers. */
const previews = [
  { id: "brick", model: brick, muzzle: BRICK_MUZZLE, def: WEAPON, x: 0 },
  { id: "needle", model: needle, muzzle: SNIPER_MUZZLE, def: SNIPER, x: 0 },
  // (The pair is shown centred: the right launcher is at the model's origin, the left beside it.)
  { id: "spears", model: spears, muzzle: SPEAR_MUZZLE, def: SPEAR, x: SPEAR_PAIR_GAP / 2 },
].map(({ id, model: m, muzzle, def, x }) => {
  m.root.position.set(0, 1.0, x);
  m.root.rotation.y = -Math.PI / 2;
  m.root.visible = false;
  const flash = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.09, 0.05),
    new THREE.MeshBasicMaterial({ color: PALETTE.HAZARD }),
  );
  flash.position.copy(muzzle);
  flash.visible = false;
  m.root.add(flash);
  scene.add(m.root);
  return { id, model: m, flash, muzzle, def };
});
/** The preview for the model chosen in the panel (the rifle if a character is chosen). */
const shownPreview = () => previews.find((p) => p.id === model.id) ?? previews[0];
const view = new RetroRenderer(canvas, scene);
window.addEventListener("resize", () => view.resize());

// Hitbox outline: standing 1.8 m with the head zone above headMinHeight; crouching 1.2 m; sliding 1.0 m.
const hitbox = new THREE.Group();
const outline = (h: number, y: number) => {
  const w = P.halfWidth * 2;
  const line = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, w)),
    new THREE.LineBasicMaterial({ color: PALETTE.SIGNAL }),
  );
  line.position.y = y;
  hitbox.add(line);
  return line;
};
// The head is the top COMBAT.headSize of the body (so it follows the real hitbox).
const HEAD_MIN = P.standHeight - COMBAT.headSize;
const standBox = [
  outline(HEAD_MIN, HEAD_MIN / 2),
  outline(P.standHeight - HEAD_MIN, (HEAD_MIN + P.standHeight) / 2),
];
const crouchBox = outline(P.crouchHeight, P.crouchHeight / 2);
const slideBox = outline(P.slideHeight, P.slideHeight / 2);
hitbox.visible = false;
scene.add(hitbox);

// --- Animations you can pick ---------------------------------------------------
const ANIMATIONS = [
  ["idle", "Idle"],
  ["walk", "Walk"],
  ["run", "Run"],
  ["jump", "Jump"],
  ["doublejump", "Double jump"],
  ["crouchstill", "Crouch (still)"],
  ["crouchwalk", "Crouch walk"],
  ["slide", "Slide"],
  ["dash", "Dash"],
  ["wallrun", "Wall run"],
  ["aim", "Aim"],
  ["shoot", "Shoot"],
  ["equip", "Equip gun (draw)"],
  ["melee", "Melee swing"],
  ["hit", "Hit (flinch)"],
  ["die", "Die"],
] as const;
/** The Assassin's two blade skills (only listed for the Assassin). */
const ASSASSIN_ANIMATIONS = [
  ["slash", "Dash cut (Shift)"],
  ["dive", "Rolling dive (E)"],
] as const;
const WEAPON_ANIMATIONS = [
  ["w-idle", "Idle (full)"],
  ["w-fire", "Fire (loop)"],
  ["w-reload", "Reload (loop)"],
  ["w-drain", "Ammo strip (drain)"],
  ["w-low", "Low ammo (blink)"],
] as const;
type WeaponAnimId = (typeof WEAPON_ANIMATIONS)[number][0];
type AnimId =
  | (typeof ANIMATIONS)[number][0]
  | (typeof ASSASSIN_ANIMATIONS)[number][0]
  | (typeof WEAPON_ANIMATIONS)[number][0];
/** One-shot animations repeat on their own while selected, so there is always something to see. */
const REPEATING = new Set<AnimId>([
  "jump",
  "doublejump",
  "dash",
  "hit",
  "equip",
  "melee",
  "slash",
  "dive",
]);
const REPEAT_SECONDS = 1.8;
const FIRE_SECONDS = 60 / 600; // the rifle's 600 rpm

for (const m of MODELS) modelSelect.add(new Option(m.name, m.id));
/** Fill the animation list for the current kind of model. */
function fillAnimations(): void {
  animSelect.length = 0;
  const list = model.kind === "weapon" ? WEAPON_ANIMATIONS : ANIMATIONS;
  for (const [id, name] of list) animSelect.add(new Option(name, id));
  if (model.id === "assassin")
    for (const [id, name] of ASSASSIN_ANIMATIONS) animSelect.add(new Option(name, id));
  animSelect.value = model.kind === "weapon" ? "w-fire" : "walk";
}
fillAnimations();
/** What the character can carry. The Brick comes with arms that hold it in every animation. */
const WEAPONS = [
  ["none", "None (Assassin: blades)"],
  ["brick", "Brick (rifle)"],
  ["needle", "Needle (sniper)"],
  ["spears", "Spears (launchers, one on each arm)"],
] as const;
for (const [id, name] of WEAPONS) weaponSelect.add(new Option(name, id));
weaponSelect.value = "brick";
const weaponOn = () => weaponSelect.value !== "none";

for (const m of FX_MODES) fxSelect.add(new Option(m.name, m.id));
fxSelect.value = view.effect;

// --- Fake player ------------------------------------------------------------
type Gait = "idle" | "walk" | "run" | "crouch";
const GAIT_SPEED: Record<Gait, number> = {
  idle: 0,
  walk: 3.5,
  run: P.runSpeed,
  crouch: P.crouchSpeed,
};
const RANGE = 6; // runs back and forth between -RANGE and +RANGE on X
const state: BodyState = {
  x: 0,
  y: 0,
  z: 0,
  onGround: true,
  sliding: false,
  alive: true,
  wallRunning: false,
  crouching: false,
  dashing: false,
  aiming: false,
  armed: true,
  weapon: 0,
  meleeing: false,
};
let gait: Gait = "walk";
let dir = 1;
let speed = 0;
let vy = 0;
let slideT = 0;
let deadT = 0;
let dashT = 0;
let airJumpAt = -1; // seconds until the double jump's second kick (-1 = none planned)
let repeatT = 0;
let meleeOff = 0; // seconds until the melee flag clears (the swing itself plays on the rising edge)
let slashOff = 0; // seconds until the slash flag clears (the cut plays on the rising edge)
let slashDashIn = 0; // seconds until the dash cut's dash starts (its wind-up)
let diveIn = 0; // seconds until the rolling dive dives (its wind-up)
/** Where the rolling dive starts from, and how steeply it goes down (the game's shallowest dive). */
const DIVE_HEIGHT = 10;
const DIVE_DOWN = Math.sin(SKILL.rollMinDive); // rollMinDive is an angle below level, in radians
let equipAt = 0; // seconds until the gun is drawn (the equip animation holsters it first)
let weaponT = 0;
let flashLeft = 0;
let ammo = 1;
let weaponAnim: WeaponAnimId = "w-fire";
const weaponPose: ReloadPose = { roll: 0, pitch: 0, drop: 0, mag: 0, hand: 0 };
let fireT = 0;

// Camera: drag to turn it around the character, scroll or arrows to zoom.
let angle = 0.3;
let elevation = 0.1;
let distance = 4;
let focusY = 0.9;
const facing = new THREE.Vector3();

/** Back to plain standing on the ground (leaves a wall run, a jump, a slide, a crouch or a dash). */
function resetStance(): void {
  state.wallRunning = false;
  state.sliding = false;
  state.crouching = false;
  state.dashing = false;
  state.rolling = false;
  slashDashIn = 0;
  diveIn = 0;
  state.divePrep = false;
  state.alive = true;
  state.onGround = true;
  state.y = 0;
  vy = 0;
  dashT = 0;
  airJumpAt = -1;
}

function jump(): void {
  if (!state.onGround || !state.alive) return;
  vy = P.jumpSpeed;
  state.onGround = false;
  state.sliding = false;
  slideT = 0;
}

function slide(): void {
  if (!state.onGround || !state.alive || state.sliding) return;
  state.sliding = true;
  slideT = 0;
  speed = Math.max(speed, P.slideSpeed);
}

/** Start an animation (also the "Play again" button and the repeat timer). */
function play(id: AnimId): void {
  animSelect.value = id;
  if (id.startsWith("w-")) {
    weaponAnim = id as WeaponAnimId;
    weaponT = 0;
    ammo = id === "w-low" ? 0.2 : 1;
    return;
  }
  repeatT = 0;
  // A dash pressed in the air stays in the air (press F during a jump or double jump).
  if (!(id === "dash" && !state.onGround && !state.wallRunning)) resetStance();
  if (gait === "crouch") gait = "run"; // a crouch walk does not carry over to the next animation
  if (id !== "aim" && id !== "shoot") aimCheck.checked = fireCheck.checked = false;
  if (id === "idle" || id === "walk" || id === "run") {
    gait = id;
  } else if (id === "jump") {
    gait = "idle"; // jump on the spot, so the pose is easy to see
    jump();
  } else if (id === "doublejump") {
    gait = "idle";
    jump();
    airJumpAt = 0.3;
  } else if (id === "crouchstill" || id === "crouchwalk") {
    gait = id === "crouchwalk" ? "crouch" : "idle";
    state.crouching = true;
  } else if (id === "slide") {
    slide();
  } else if (id === "dash") {
    dashT = P.dashDuration;
    state.dashing = true;
    speed = P.dashSpeed;
  } else if (id === "wallrun") {
    gait = "run";
    speed = GAIT_SPEED.run;
    state.wallRunning = true;
    state.onGround = false;
    state.y = 1.6; // held in the air beside the wall
  } else if (id === "slash") {
    // The dash cut: the blades are drawn and cut an X, then comes the dash straight ahead.
    gait = "idle";
    state.slashing = true;
    slashOff = 0.25;
    slashDashIn = SKILL.slashWindup;
  } else if (id === "dive") {
    // The rolling dive: up in the air the blades are drawn (the wind-up), then it tumbles forward
    // and down until it lands, and the blades go back.
    gait = "idle";
    state.onGround = false;
    state.y = DIVE_HEIGHT;
    vy = 4; // a little rise, so the wind-up is not spent falling
    state.divePrep = true;
    diveIn = SKILL.rollWindup;
  } else if (id === "melee") {
    gait = "idle";
    // (The Assassin with no gun has its blades out: the swing is a cut with both.)
    if (!weaponOn() && model.id !== "assassin") weaponSelect.value = "brick";
    state.meleeing = true;
    meleeOff = 0.4;
  } else if (id === "equip") {
    gait = "idle";
    if (!weaponOn()) weaponSelect.value = "brick";
    state.armed = false; // holster, then draw
    equipAt = 0.35;
  } else if (id === "aim") {
    gait = "idle";
    if (!weaponOn()) weaponSelect.value = "brick"; // aiming needs a gun
    aimCheck.checked = true;
  } else if (id === "shoot") {
    gait = "idle";
    if (!weaponOn()) weaponSelect.value = "brick";
    aimCheck.checked = true;
    fireCheck.checked = true;
  } else if (id === "hit") {
    body.hit();
  } else {
    state.alive = false;
    deadT = 0;
  }
}

animSelect.addEventListener("change", () => {
  play(animSelect.value as AnimId);
  animSelect.blur(); // keep Space and the number keys for the viewer
});
replayButton.addEventListener("click", () => {
  play(animSelect.value as AnimId);
  replayButton.blur();
});
modelSelect.addEventListener("change", () => {
  const next = MODELS.find((m) => m.id === modelSelect.value);
  if (!next) return;
  model = next;
  state.x = 0;
  resetStance();
  distance = model.kind === "weapon" ? 1.5 : 4; // a rifle is small: come closer
  if (model.kind === "character") body = bodies[model.id];
  for (const b of Object.values(bodies)) b.root.visible = model.kind === "character" && b === body;
  for (const p of previews) p.model.root.visible = model.kind === "weapon" && p.id === model.id;
  fillAnimations();
  play(animSelect.value as AnimId);
  modelSelect.blur();
});
weaponSelect.addEventListener("change", () => weaponSelect.blur()); // picking a gun plays the draw
fxSelect.addEventListener("change", () => {
  view.setEffect(fxSelect.value as FxMode);
  fxSelect.blur();
});

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (model.kind === "character") characterKeys(e);
  generalKeys(e);
});

function characterKeys(e: KeyboardEvent): void {
  if (e.code === "Digit1") play("idle");
  if (e.code === "Digit2") play("walk");
  if (e.code === "Digit3") play("run");
  if (e.code === "Space") {
    e.preventDefault();
    play("jump");
  }
  if (e.code === "KeyD") play("doublejump");
  if (e.code === "KeyC") play("crouchwalk");
  if (e.code === "KeyS") play("slide");
  if (e.code === "KeyF") play("dash");
  if (e.code === "KeyW") play("wallrun");
  if (e.code === "KeyA") play("aim");
  // The Assassin's own keys, as in the game: Shift is the dash cut, E the rolling dive.
  const assassin = model.id === "assassin";
  if (assassin && (e.code === "ShiftLeft" || e.code === "ShiftRight")) play("slash");
  if (e.code === "KeyE") play(assassin ? "dive" : "shoot");
  if (e.code === "KeyG") play("equip");
  if (e.code === "KeyV") play("melee");
  if (e.code === "KeyH") play("hit");
  if (e.code === "KeyK") play("die");
}

function generalKeys(e: KeyboardEvent): void {
  if (e.code === "KeyB") hitboxCheck.checked = !hitboxCheck.checked;
  if (e.code === "ArrowLeft") angle -= 0.3;
  if (e.code === "ArrowRight") angle += 0.3;
  if (e.code === "ArrowUp") distance = Math.max(1.5, distance - 0.5);
  if (e.code === "ArrowDown") distance = Math.min(12, distance + 0.5);
}

// Drag to turn the camera (not when the drag starts on the panel), wheel to zoom.
let dragging = false;
canvas.addEventListener("pointerdown", (e) => {
  if (panel.contains(e.target as Node)) return;
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  angle -= e.movementX * 0.01;
  elevation = Math.min(1.3, Math.max(-0.2, elevation + e.movementY * 0.01));
});
const endDrag = () => (dragging = false);
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("lostpointercapture", endDrag);
window.addEventListener("blur", endDrag);
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    distance = Math.min(12, Math.max(1.5, distance * Math.exp(e.deltaY * 0.001)));
  },
  { passive: false },
);

/** The weapon preview: fire, reload and ammo strip loops. */
function stepWeapon(dt: number): void {
  weaponT += dt;
  const pv = shownPreview();
  if (!pv) return;
  const brick = pv.model;
  const brickFlash = pv.flash;
  brickFlash.visible = false;
  brick.mag.position.y = BRICK_MAG_HOME.y;
  // Each gun fires and reloads at its own pace (the spears: two shots, then a long reload).
  const def = pv.def;
  const fireSeconds = 60 / def.rpm;
  let reloading = -1; // how far through a reload of its own the gun is (the spear launchers)
  if (weaponAnim === "w-fire") {
    ammo = Math.max(0, ammo);
    if (weaponT >= fireSeconds) {
      weaponT -= fireSeconds;
      brick.shoot();
      // (With the spears the left one goes first: the flash is at that muzzle.)
      const leftFirst = pv.id === "spears" && ammo > 0.75;
      brickFlash.position.copy(pv.muzzle);
      if (leftFirst) brickFlash.position.x -= SPEAR_PAIR_GAP;
      ammo -= 1 / def.magSize;
      if (ammo <= 0.001) ammo = 1; // refill, so it keeps firing
      flashLeft = 0.04;
    }
  } else if (weaponAnim === "w-reload") {
    const t = weaponT % (def.reloadTime + 0.8);
    const progress = Math.min(1, t / def.reloadTime);
    if (brick.reload) {
      reloading = progress;
      ammo = progress < 0.3 ? 0 : progress < 0.55 ? 0.5 : 1; // as each spear goes on
    } else {
      const r = reloadPose(progress, weaponPose);
      brick.mag.position.y = BRICK_MAG_HOME.y + r.mag;
      ammo = progress < 0.74 ? 0 : 1; // the strip refills when the new magazine seats
    }
  } else if (weaponAnim === "w-drain") {
    ammo = 1 - (weaponT % 4) / 4;
  }
  flashLeft = Math.max(0, flashLeft - dt);
  brickFlash.visible = flashLeft > 0;
  brick.update(dt, ammo, performance.now() / 1000);
  brick.reload?.(reloading);
}

function stepFakePlayer(dt: number): void {
  if (!state.alive) {
    deadT += dt;
    if (deadT > 2) state.alive = true;
    return;
  }
  if (REPEATING.has(animSelect.value as AnimId)) {
    repeatT += dt;
    if (repeatT > REPEAT_SECONDS) play(animSelect.value as AnimId);
  }
  state.diveLeft = state.rolling ? state.y / (SKILL.rollSpeed * DIVE_DOWN) : undefined;
  if (state.rolling) {
    // Straight along the dive at its fixed speed: no gravity until it lands.
    speed = SKILL.rollSpeed * Math.sqrt(1 - DIVE_DOWN * DIVE_DOWN);
    state.y -= SKILL.rollSpeed * DIVE_DOWN * dt;
    if (state.y <= 0) {
      state.y = 0;
      vy = 0;
      state.onGround = true;
      state.rolling = false;
      speed *= SKILL.rollExitScale;
    }
  } else if (dashT > 0) {
    dashT -= dt;
    speed = P.dashSpeed;
    if (dashT <= 0) {
      state.dashing = false;
      speed = P.dashExitSpeed;
    }
  } else if (state.sliding) {
    slideT += dt;
    speed = Math.max(0, speed - P.slideDecel * dt);
    if (slideT > P.slideMaxTime || speed < P.slideEndSpeed) state.sliding = false;
  } else {
    // Ease toward the chosen gait speed, like ground acceleration.
    speed += (GAIT_SPEED[gait] - speed) * (1 - Math.exp(-dt * 8));
  }
  state.x += dir * speed * dt;
  if (state.x > RANGE) dir = -1;
  if (state.x < -RANGE) dir = 1;
  // The wall is on the -Z side: on the body's own +X side when running toward +X (for the cable).
  state.wallSide = state.wallRunning ? dir : 0;
  if (airJumpAt > 0) {
    airJumpAt -= dt;
    if (airJumpAt <= 0) {
      vy = P.airJumpSpeed;
      airJumpAt = -1;
    }
  }
  if (dashT > 0 && !state.onGround) vy = 0; // a dash holds its height
  if (!state.onGround && !state.wallRunning && !state.rolling && dashT <= 0) {
    vy -= P.gravity * dt;
    state.y += vy * dt;
    if (state.y <= 0) {
      state.y = 0;
      vy = 0;
      state.onGround = true;
    }
  }
  if (diveIn > 0) {
    diveIn -= dt;
    if (diveIn <= 0) {
      state.divePrep = false;
      state.rolling = !state.onGround; // landing first calls it off
    }
  }
  if (slashDashIn > 0) {
    slashDashIn -= dt;
    if (slashDashIn <= 0) {
      dashT = P.dashDuration;
      speed = P.dashSpeed;
    }
  }
  if (slashOff > 0) {
    slashOff -= dt;
    if (slashOff <= 0) state.slashing = false;
  }
  if (meleeOff > 0) {
    meleeOff -= dt;
    if (meleeOff <= 0) state.meleeing = false;
  }
  if (equipAt > 0) {
    equipAt -= dt;
    state.armed = equipAt <= 0 && weaponOn();
  } else {
    state.armed = weaponOn();
  }
  state.weapon = weaponSelect.value === "needle" ? 1 : weaponSelect.value === "spears" ? 2 : 0;
  state.aiming = aimCheck.checked;
  if (fireCheck.checked) {
    fireT -= dt;
    if (fireT <= 0) {
      body.shoot();
      fireT = FIRE_SECONDS;
    }
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (model.kind === "weapon") stepWeapon(dt);
  else stepFakePlayer(dt);

  const cam = view.camera;
  // Aim at the middle of the body, which is higher during the wall run and the jumps.
  focusY = model.kind === "weapon" ? 1.0 : 0.9 + state.y * 0.8;
  cam.position.set(
    state.x + Math.sin(angle) * Math.cos(elevation) * distance,
    focusY + Math.sin(elevation) * distance,
    Math.cos(angle) * Math.cos(elevation) * distance,
  );
  cam.lookAt(state.x, focusY, 0);
  hitbox.position.set(state.x, state.y, state.z);
  hitbox.visible = hitboxCheck.checked && model.kind === "character";
  const low = state.sliding;
  const crouched = state.crouching === true && !low;
  for (const l of standBox) l.visible = !low && !crouched;
  crouchBox.visible = crouched;
  slideBox.visible = low;
  // Hidden when the camera goes round behind it, so it never blocks the view.
  wall.visible = wallStripe.visible = state.wallRunning === true && cam.position.z > WALL_FACE_Z;
  // A standing character faces +Z (toward the starting camera) instead of following the camera,
  // so you can walk round it and see it from the side.
  facing.set(state.x, 1, 50);
  if (model.kind === "character") body.update(state, dt, facing);
  view.render();

  const doing = !state.alive
    ? "dead"
    : state.rolling || state.divePrep
      ? "rolling dive"
      : state.slashing
        ? "dash cut"
        : state.wallRunning
          ? "wall run"
          : state.dashing
            ? "dash"
            : state.sliding
              ? "slide"
              : !state.onGround
                ? vy > 0
                  ? "jump (rising)"
                  : "jump (falling)"
                : state.crouching
                  ? "crouch"
                  : gait;
  const skillKeys = model.id === "assassin" ? "Shift slash · E dive" : "E shoot";
  if (model.kind === "weapon") {
    help.textContent =
      `${model.name}: ammo ${Math.round(ammo * (shownPreview()?.def.magSize ?? 0))} / ${shownPreview()?.def.magSize ?? 0}\n` +
      "pick Fire, Reload or the ammo strip in the panel\n" +
      "drag turn camera · scroll/arrows zoom · ?res=240 retro look";
    requestAnimationFrame(frame);
    return;
  }
  help.textContent =
    `${model.name}: ${doing}${aimCheck.checked ? " + aim" : ""}${fireCheck.checked ? " + fire" : ""}  ${speed.toFixed(1)} m/s\n` +
    `1 idle · 2 walk · 3 run · Space jump · D double jump · C crouch · S slide · F dash · W wall run · A aim · ${skillKeys} · G draw gun · V melee · H hit · K kill\n` +
    "B hitbox · drag turn camera · scroll/arrows zoom · ?res=240 retro look";
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
