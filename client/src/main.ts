import * as THREE from "three";
import greybox from "../../levels/greybox.json";
import { aliveHitboxes, type Dummy, killDummy, makeDummies, stepDummies } from "./dummies";
import { DummyViews } from "./dummyView";
import { Fx } from "./fx";
import { buildLevelMeshes } from "./levelRender";
import { FixedTimestep, TICK_RATE } from "./loop";
import { connect, type NetStatus } from "./net";
import { RENDER_HEIGHT, RENDER_WIDTH, RetroRenderer } from "./render";
import { castRay } from "./sim/hitscan";
import { buildCollisionWorld, parseLevel } from "./sim/level";
import { bodyHeight, eyeHeight, hSpeed, spawnState, stepPlayer } from "./sim/movement";
import { PARAMS, WEAPON } from "./sim/params";
import { emptyInput, type PlayerState } from "./sim/types";
import {
  applyDamage,
  damageFor,
  type ShotResult,
  spawnWeapon,
  spreadDegrees,
  stepWeapon,
  viewDirection,
} from "./sim/weapon";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLDivElement;

// --- Level -----------------------------------------------------------------
const level = parseLevel(greybox);
const world = buildCollisionWorld(level);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101820);
scene.fog = new THREE.Fog(0x101820, 30, 90);
scene.add(buildLevelMeshes(level));
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(20, 40, 10);
scene.add(sun);

const view = new RetroRenderer(canvas, scene);
window.addEventListener("resize", () => view.resize());

const HIP_FOV = 75;
const HITSTOP_TICKS = 4; // about 67 ms: dummies freeze when one dies

const dummies: Dummy[] = makeDummies(level.targets);
const dummyViews = new DummyViews(scene, dummies);
const fx = new Fx(scene, view.camera);
const targetInfo = document.getElementById("targetinfo") as HTMLDivElement;
const ammoEl = document.getElementById("ammo") as HTMLDivElement;

// --- Player ----------------------------------------------------------------
const spawn = level.spawnZones[0];
const spawnPos = spawn ? spawn.pos : ([0, 0, 0] as const);
let player: PlayerState = spawnState(spawnPos[0], spawnPos[1], spawnPos[2]);
let prevPlayer: PlayerState = player;
const look = { yaw: 0, pitch: 0 }; // yaw 0 faces -Z, toward the arena centre from spawn zone 0

// --- Input -----------------------------------------------------------------
const held = new Set<string>();
const pressed = { jump: false, dash: false, reload: false };

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  held.add(e.code);
  if (e.code === "Space") pressed.jump = true;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") pressed.dash = true;
  if (e.code === "KeyR") pressed.reload = true;
  if (e.code === "KeyP") {
    player = spawnState(spawnPos[0], spawnPos[1], spawnPos[2]);
    prevPlayer = player;
  }
});
window.addEventListener("keyup", (e) => held.delete(e.code));

const MOUSE_SENS = 0.0022;
const clampPitch = (p: number) => Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, p));
let adsT = 0; // 0 = hip, 1 = fully aimed (smoothed per frame)
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  const sens = MOUSE_SENS * (1 + (WEAPON.adsSensitivity - 1) * adsT);
  look.yaw -= e.movementX * sens;
  look.pitch = clampPitch(look.pitch - e.movementY * sens);
});
document.addEventListener("mousedown", (e) => {
  if (document.pointerLockElement === canvas) held.add(`Mouse${e.button}`);
});
document.addEventListener("mouseup", (e) => held.delete(`Mouse${e.button}`));
document.addEventListener("contextmenu", (e) => e.preventDefault());
hint.addEventListener("click", () => canvas.requestPointerLock());
canvas.addEventListener("click", () => canvas.requestPointerLock());
document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === canvas;
  hint.classList.toggle("hidden", locked);
  if (!locked) held.clear();
});

const axis = (pos: string, neg: string) => Number(held.has(pos)) - Number(held.has(neg));

// --- Networking (connection status only, for now) --------------------------
let net: NetStatus = { state: "connecting", playerId: null, serverTick: null };
connect((s) => {
  net = s;
});

// --- Simulation ------------------------------------------------------------
const DT = 1 / TICK_RATE;
let simTicks = 0;
let weapon = spawnWeapon(1);
let shotsFired = 0;
let hitstopTicks = 0;
let killLog = "no kills yet";
let targetInfoUntil = 0;

function fireShot(shot: ShotResult, ads: boolean): void {
  shotsFired++;
  const origin: [number, number, number] = [player.x, player.y + eyeHeight(player), player.z];
  const dir = viewDirection(look.yaw + shot.spreadYaw, look.pitch + shot.spreadPitch);
  const hit = castRay(world, aliveHitboxes(dummies), origin, dir);
  fx.shot(new THREE.Vector3(hit.x, hit.y, hit.z), hit.kind === "world", ads);

  const d = hit.kind === "target" ? dummies[hit.targetId] : undefined;
  if (d?.alive) {
    if (d.firstHitAt === null) {
      d.firstHitAt = simTicks * DT;
      d.shotsAtFirstHit = shotsFired;
    }
    d.hits++;
    if (hit.headshot) d.headshots++;
    const result = applyDamage(d, damageFor(hit.headshot));
    dummyViews.flash(d.id);
    targetInfo.textContent = `${d.name}\nshield ${Math.ceil(d.shield)}   hp ${Math.ceil(d.health)}`;
    targetInfo.classList.add("on");
    targetInfoUntil = performance.now() + 1200;
    if (result.killed) {
      const ttk = simTicks * DT - (d.firstHitAt ?? 0);
      killLog = `last kill ${ttk.toFixed(2)}s | ${shotsFired - d.shotsAtFirstHit + 1} shots, ${d.hits} hits, ${d.headshots} head`;
      killDummy(d);
      fx.hitMarker("kill");
      hitstopTicks = HITSTOP_TICKS;
    } else {
      fx.hitMarker(hit.headshot ? "head" : "body");
    }
  }

  // View kick: the player counters it with the mouse.
  look.yaw += shot.kickYaw;
  look.pitch = clampPitch(look.pitch + shot.kickPitch);
}

const sim = new FixedTimestep(() => {
  simTicks++;
  const ads = held.has("Mouse2");
  prevPlayer = player;
  player = stepPlayer(
    player,
    {
      ...emptyInput(),
      moveX: axis("KeyD", "KeyA"),
      moveZ: axis("KeyW", "KeyS"),
      yaw: look.yaw,
      jump: pressed.jump,
      jumpHeld: held.has("Space"),
      dash: pressed.dash,
      slide: held.has("KeyC"),
      ads,
    },
    world,
    DT,
  );

  stepDummies(dummies, DT, hitstopTicks > 0);
  if (hitstopTicks > 0) hitstopTicks--;

  const res = stepWeapon(
    weapon,
    { fire: held.has("Mouse0"), reload: pressed.reload, ads },
    {
      hSpeed: hSpeed(player),
      onGround: player.onGround,
      crouching: player.crouching,
      sliding: player.sliding,
    },
    DT,
  );
  weapon = res.state;
  if (res.shot.fired) fireShot(res.shot, ads);

  pressed.jump = false;
  pressed.dash = false;
  pressed.reload = false;
});

// --- Render ----------------------------------------------------------------
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
let eye = PARAMS.standEye;
let lastFrame = 0;

function frame(nowMs: number): void {
  const frameDt = Math.min(0.1, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  const alpha = sim.advance(nowMs);
  const cam = view.camera;

  // Aim down sights: smooth zoom.
  const adsHeld = held.has("Mouse2");
  adsT += ((adsHeld ? 1 : 0) - adsT) * (1 - Math.exp(-frameDt * 14));
  const fov = HIP_FOV * (1 + (WEAPON.adsFovScale - 1) * adsT);
  if (Math.abs(cam.fov - fov) > 0.01) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }

  // Smooth the eye height so slide transitions don't pop.
  eye += (eyeHeight(player) - eye) * (1 - Math.exp(-frameDt * 18));
  cam.position.set(
    lerp(prevPlayer.x, player.x, alpha),
    lerp(prevPlayer.y, player.y, alpha) + eye,
    lerp(prevPlayer.z, player.z, alpha),
  );
  const spread = spreadDegrees(weapon.burst, adsHeld, {
    hSpeed: hSpeed(player),
    onGround: player.onGround,
    crouching: player.crouching,
    sliding: player.sliding,
  });
  const shake = fx.update(frameDt, adsT, spread, fov);
  cam.rotation.set(look.pitch + shake.pitch, look.yaw + shake.yaw, 0);
  dummyViews.update(dummies, frameDt);
  if (targetInfoUntil < nowMs) targetInfo.classList.remove("on");
  ammoEl.innerHTML = `${weapon.ammo} / ${WEAPON.magSize}<small>${
    weapon.reloadT > 0
      ? `RELOADING ${weapon.reloadT.toFixed(1)}s`
      : weapon.ammo === 0
        ? "RELOAD (R)"
        : ""
  }</small>`;
  view.render();

  const state = [
    player.onGround ? "ground" : "air",
    player.sliding ? "slide" : "",
    player.crouching ? "crouch" : "",
    player.climbing ? "climb" : "",
    player.dashTime > 0 ? "dash" : "",
    player.mantling ? "mantle" : "",
  ]
    .filter(Boolean)
    .join(" ");
  hud.textContent =
    `speed ${hSpeed(player).toFixed(1)} m/s | ${state} | height ${bodyHeight(player).toFixed(1)}\n` +
    `jumps ${"●".repeat(player.airJumps)}${"○".repeat(PARAMS.maxAirJumps - player.airJumps)}  dash ${"●".repeat(Math.floor(player.dashCharges))}${"○".repeat(PARAMS.dashCharges - Math.floor(player.dashCharges))}  ` +
    `(${(player.dashCharges % 1).toFixed(2)})\n` +
    `${killLog}\n` +
    `WASD move · Space jump (hold at green walls to climb) · Shift dash · C crouch/slide · LMB fire · RMB aim · R reload · P respawn\n` +
    `render ${RENDER_WIDTH}x${RENDER_HEIGHT} (?res=240..720) | sim ticks ${simTicks} | server ${net.state}${net.serverTick !== null ? ` tick ${net.serverTick}` : ""}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
