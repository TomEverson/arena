import * as THREE from "three";

import { type BodyState, CharacterBody } from "./character";
import { PALETTE } from "./palette";
import { FX_MODES, type FxMode, RetroRenderer } from "./render";
import { COMBAT, PARAMS as P } from "./sim/params";

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
const fxSelect = document.getElementById("fx") as HTMLSelectElement;
const replayButton = document.getElementById("replay") as HTMLButtonElement;
const hitboxCheck = document.getElementById("hitbox") as HTMLInputElement;
const aimCheck = document.getElementById("aim") as HTMLInputElement;
const fireCheck = document.getElementById("fire") as HTMLInputElement;
const panel = document.getElementById("panel") as HTMLDivElement;

/**
 * The models you can preview. Add a row (and a builder) here when there is another one; the
 * selector in the panel lists whatever is in this table.
 */
const MODELS: { id: string; name: string; build: (scene: THREE.Scene) => CharacterBody }[] = [
  { id: "dummy", name: "Dummy", build: (sc) => new CharacterBody(sc) },
];

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

let model = MODELS[0] as (typeof MODELS)[number];
let body = model.build(scene);
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
  ["hit", "Hit (flinch)"],
  ["die", "Die"],
] as const;
type AnimId = (typeof ANIMATIONS)[number][0];
/** One-shot animations repeat on their own while selected, so there is always something to see. */
const REPEATING = new Set<AnimId>(["jump", "doublejump", "dash", "hit"]);
const REPEAT_SECONDS = 1.8;
const FIRE_SECONDS = 60 / 600; // the rifle's 600 rpm

for (const m of MODELS) modelSelect.add(new Option(m.name, m.id));
for (const [id, name] of ANIMATIONS) animSelect.add(new Option(name, id));
animSelect.value = "walk";
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
  repeatT = 0;
  resetStance();
  if (gait === "crouch") gait = "run"; // a crouch walk does not carry over to the next animation
  if (id !== "aim" && id !== "shoot") aimCheck.checked = fireCheck.checked = false;
  if (id === "idle" || id === "walk" || id === "run") {
    gait = id;
  } else if (id === "jump") {
    jump();
  } else if (id === "doublejump") {
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
  } else if (id === "aim") {
    gait = "idle";
    aimCheck.checked = true;
  } else if (id === "shoot") {
    gait = "idle";
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
  scene.remove(body.root);
  model = next;
  body = model.build(scene);
  modelSelect.blur();
});
fxSelect.addEventListener("change", () => {
  view.setEffect(fxSelect.value as FxMode);
  fxSelect.blur();
});
hitboxCheck.addEventListener("change", () => (hitbox.visible = hitboxCheck.checked));

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
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
  if (e.code === "KeyE") play("shoot");
  if (e.code === "KeyH") play("hit");
  if (e.code === "KeyK") play("die");
  if (e.code === "KeyB") hitbox.visible = hitboxCheck.checked = !hitbox.visible;
  if (e.code === "ArrowLeft") angle -= 0.3;
  if (e.code === "ArrowRight") angle += 0.3;
  if (e.code === "ArrowUp") distance = Math.max(1.5, distance - 0.5);
  if (e.code === "ArrowDown") distance = Math.min(12, distance + 0.5);
});

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
  if (dashT > 0) {
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
  if (airJumpAt > 0) {
    airJumpAt -= dt;
    if (airJumpAt <= 0) {
      vy = P.airJumpSpeed;
      airJumpAt = -1;
    }
  }
  if (!state.onGround && !state.wallRunning) {
    vy -= P.gravity * dt;
    state.y += vy * dt;
    if (state.y <= 0) {
      state.y = 0;
      vy = 0;
      state.onGround = true;
    }
  }
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
  stepFakePlayer(dt);

  const cam = view.camera;
  // Aim at the middle of the body, which is higher during the wall run and the jumps.
  focusY = 0.9 + state.y * 0.8;
  cam.position.set(
    state.x + Math.sin(angle) * Math.cos(elevation) * distance,
    focusY + Math.sin(elevation) * distance,
    Math.cos(angle) * Math.cos(elevation) * distance,
  );
  cam.lookAt(state.x, focusY, 0);
  hitbox.position.set(state.x, state.y, state.z);
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
  body.update(state, dt, facing);
  view.render();

  const doing = !state.alive
    ? "dead"
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
  help.textContent =
    `${model.name}: ${doing}${aimCheck.checked ? " + aim" : ""}${fireCheck.checked ? " + fire" : ""}  ${speed.toFixed(1)} m/s\n` +
    "1 idle · 2 walk · 3 run · Space jump · D double jump · C crouch · S slide · F dash · W wall run · A aim · E shoot · H hit · K kill\n" +
    "B hitbox · drag turn camera · scroll/arrows zoom · ?res=240 retro look";
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
