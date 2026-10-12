import * as THREE from "three";

import { type BodyState, CharacterBody } from "./character";
import { PALETTE } from "./palette";
import { RetroRenderer } from "./render";
import { COMBAT, PARAMS as P } from "./sim/params";

/**
 * Dev-only character viewer and animation test stage (open /figure.html while `pnpm dev`
 * runs). A fake player moves back and forth using the game's real speeds, jump and gravity,
 * so every animation can be checked up close. Same lights and screen effect as the game.
 * Not part of the game build. Visual only: this is not the real movement code.
 */

const canvas = document.getElementById("game") as HTMLCanvasElement;
const help = document.getElementById("help") as HTMLDivElement;

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

const body = new CharacterBody(scene);
const view = new RetroRenderer(canvas, scene);
window.addEventListener("resize", () => view.resize());

// Hitbox outline: standing 1.8 m with the head zone above headMinHeight; sliding 1.0 m.
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
const slideBox = outline(P.slideHeight, P.slideHeight / 2);
hitbox.visible = false;
scene.add(hitbox);

// --- Fake player ------------------------------------------------------------
type Gait = "idle" | "walk" | "run";
const GAIT_SPEED: Record<Gait, number> = { idle: 0, walk: 3.5, run: P.runSpeed };
const RANGE = 6; // runs back and forth between -RANGE and +RANGE on X
const state: BodyState = { x: 0, y: 0, z: 0, onGround: true, sliding: false, alive: true };
let gait: Gait = "walk";
let dir = 1;
let speed = 0;
let vy = 0;
let slideT = 0;
let deadT = 0;

let orbiting = false;
let angle = 0.3;
let distance = 4;
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === "Digit1") gait = "idle";
  if (e.code === "Digit2") gait = "walk";
  if (e.code === "Digit3") gait = "run";
  if (e.code === "Space" && state.onGround && state.alive) {
    vy = P.jumpSpeed;
    state.onGround = false;
    state.sliding = false;
    slideT = 0;
  }
  if (e.code === "KeyC" && state.onGround && state.alive && !state.sliding) {
    state.sliding = true;
    slideT = 0;
    speed = Math.max(speed, P.slideSpeed);
  }
  if (e.code === "KeyH") body.hit();
  if (e.code === "KeyK" && state.alive) {
    state.alive = false;
    deadT = 0;
  }
  if (e.code === "KeyB") hitbox.visible = !hitbox.visible;
  if (e.code === "KeyO") orbiting = !orbiting;
  if (e.code === "ArrowLeft") angle -= 0.3;
  if (e.code === "ArrowRight") angle += 0.3;
  if (e.code === "ArrowUp") distance = Math.max(1.5, distance - 0.5);
  if (e.code === "ArrowDown") distance = Math.min(12, distance + 0.5);
});

function stepFakePlayer(dt: number): void {
  if (!state.alive) {
    deadT += dt;
    if (deadT > 2) state.alive = true;
    return;
  }
  if (state.sliding) {
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
  if (!state.onGround) {
    vy -= P.gravity * dt;
    state.y += vy * dt;
    if (state.y <= 0) {
      state.y = 0;
      vy = 0;
      state.onGround = true;
    }
  }
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  stepFakePlayer(dt);
  if (orbiting) angle += dt * 0.4;

  const cam = view.camera;
  cam.position.set(state.x + Math.sin(angle) * distance, 1.3, Math.cos(angle) * distance);
  cam.lookAt(state.x, 0.8, 0);
  hitbox.position.set(state.x, state.y, state.z);
  for (const l of standBox) l.visible = !state.sliding;
  slideBox.visible = state.sliding;
  body.update(state, dt, cam.position);
  view.render();

  const doing = !state.alive
    ? "dead"
    : state.sliding
      ? "slide"
      : !state.onGround
        ? vy > 0
          ? "jump (rising)"
          : "jump (falling)"
        : gait;
  help.textContent =
    `${doing}  ${speed.toFixed(1)} m/s\n` +
    "1 idle · 2 walk · 3 run · Space jump · C slide · H hit · K kill\n" +
    "B hitbox · O orbit · arrows rotate/zoom · ?res=240 retro look · ?fx=off no effect";
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
