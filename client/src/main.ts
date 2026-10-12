import * as THREE from "three";
import { emptyKeys, type FlyState, stepFly } from "./flycam";
import { FixedTimestep, TICK_RATE } from "./loop";
import { connect, type NetStatus } from "./net";
import { RetroRenderer } from "./render";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLDivElement;

// --- Scene -----------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);
scene.add(new THREE.GridHelper(100, 100, 0x4466aa, 0x223355));
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(5, 10, 3);
scene.add(sun);

const boxMat = new THREE.MeshLambertMaterial({ color: 0xc08040 });
for (const [x, z] of [
  [-6, -8],
  [4, -12],
  [10, 2],
  [-10, 6],
]) {
  const box = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), boxMat);
  box.position.set(x ?? 0, 1.5, z ?? 0);
  scene.add(box);
}

const view = new RetroRenderer(canvas, scene);
window.addEventListener("resize", () => view.resize());

// --- Fly camera (debug) ----------------------------------------------------
// prev/curr are the two most recent sim states; render lerps between them.
const curr: FlyState = { x: 0, y: 2, z: 8, yaw: 0, pitch: 0 };
const prev: FlyState = { ...curr };
const keys = emptyKeys();

const KEY_MAP: Record<string, keyof typeof keys> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  Space: "up",
  ShiftLeft: "down",
  ShiftRight: "down",
};
const setKey = (code: string, down: boolean) => {
  const k = KEY_MAP[code];
  if (k) keys[k] = down;
};
window.addEventListener("keydown", (e) => setKey(e.code, true));
window.addEventListener("keyup", (e) => setKey(e.code, false));

const MOUSE_SENS = 0.0022;
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  curr.yaw -= e.movementX * MOUSE_SENS;
  curr.pitch -= e.movementY * MOUSE_SENS;
  curr.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, curr.pitch));
});
hint.addEventListener("click", () => canvas.requestPointerLock());
canvas.addEventListener("click", () => canvas.requestPointerLock());
document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === canvas;
  hint.classList.toggle("hidden", locked);
  if (!locked) for (const k of Object.keys(keys) as (keyof typeof keys)[]) keys[k] = false;
});

// --- Networking ------------------------------------------------------------
let net: NetStatus = { state: "connecting", playerId: null, serverTick: null };
connect((s) => {
  net = s;
});

// --- Loop ------------------------------------------------------------------
let simTicks = 0;
const sim = new FixedTimestep(() => {
  Object.assign(prev, curr);
  stepFly(curr, keys, 1 / TICK_RATE);
  simTicks++;
});

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function frame(nowMs: number): void {
  const alpha = sim.advance(nowMs);
  const cam = view.camera;
  cam.position.set(
    lerp(prev.x, curr.x, alpha),
    lerp(prev.y, curr.y, alpha),
    lerp(prev.z, curr.z, alpha),
  );
  cam.rotation.set(curr.pitch, curr.yaw, 0);
  view.render();

  hud.textContent =
    `sim ticks: ${simTicks} (${TICK_RATE} Hz)\n` +
    `server: ${net.state}` +
    (net.playerId !== null ? ` | you: #${net.playerId}` : "") +
    (net.serverTick !== null ? ` | server tick: ${net.serverTick}` : "");
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
