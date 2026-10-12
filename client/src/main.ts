import * as THREE from "three";
import greybox from "../../levels/greybox.json";
import { aliveHitboxes, type Dummy, killDummy, makeDummies, stepDummies } from "./dummies";
import { DummyViews } from "./dummyView";
import { Fx } from "./fx";
import { buildLevelMeshes } from "./levelRender";
import { FixedTimestep, TICK_RATE } from "./loop";
import { NetClient } from "./net/client";
import { ServerClock } from "./net/clock";
import { INTERP_TICKS, RemoteTracks } from "./net/interpolation";
import { Predictor } from "./net/prediction";
import { CorrectionSmoother } from "./net/smoothing";
import { RemoteViews } from "./remoteView";
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

const DT = 1 / TICK_RATE;

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
    if (net)
      net.sendRespawn(); // the server owns our position; the snapshot corrects us
    else {
      player = spawnState(spawnPos[0], spawnPos[1], spawnPos[2]);
      prevPlayer = player;
    }
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

// --- Networking ------------------------------------------------------------
// Online (default): the server owns the truth. We predict our own movement with the
// same stepPlayer, send numbered inputs, and reconcile against snapshots. Other
// players are drawn ~100 ms in the past, interpolated between snapshots.
// Offline (?offline, or no server reachable): plain local simulation for tuning.
let net: NetClient | null = null;
let netMode: "connecting" | "online" | "offline" = "connecting";
let netNote = "";
let predictor: Predictor | null = null;
const smoother = new CorrectionSmoother();
const clock = new ServerClock();
const remotes = new RemoteTracks();
const remoteViews = new RemoteViews(scene);

function goOffline(note: string): void {
  netMode = "offline";
  netNote = note;
  net = null;
  predictor = null;
}

if (new URLSearchParams(location.search).has("offline")) {
  netMode = "offline";
  netNote = "(?offline)";
} else {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  net = new NetClient(`${proto}//${location.host}/ws`, {
    onWelcome(w) {
      if (w.level !== level.name)
        netNote = `WARNING: server runs "${w.level}", client has "${level.name}"`;
    },
    onSnapshot(s) {
      clock.onSnapshot(s.tick, performance.now());
      remotes.push(s.tick, s.entities);
      if (!predictor) {
        // First snapshot: start from wherever the server put us.
        predictor = new Predictor(world, s.you, s.ackSeq, DT);
        player = prevPlayer = predictor.state;
        netMode = "online";
        return;
      }
      const correction = predictor.reconcile(s.ackSeq, s.you);
      if (correction) smoother.onCorrection(correction);
      player = predictor.state;
    },
    onClose(wasConnected) {
      goOffline(wasConnected ? "connection lost: offline mode" : "no server: offline mode");
    },
  });
}

// --- Simulation ------------------------------------------------------------
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
  const input = {
    ...emptyInput(),
    moveX: axis("KeyD", "KeyA"),
    moveZ: axis("KeyW", "KeyS"),
    yaw: look.yaw,
    jump: pressed.jump,
    jumpHeld: held.has("Space"),
    dash: pressed.dash,
    slide: held.has("KeyC"),
    ads,
  };
  prevPlayer = player;
  if (predictor) {
    // Online: predict now, tell the server (the last few inputs, so a lost message loses nothing).
    predictor.step(input, look.pitch);
    player = predictor.state;
    net?.sendInputs(predictor.recent());
  } else if (netMode === "offline") {
    player = stepPlayer(player, input, world, DT);
  } // else: still connecting, wait for the first snapshot

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

function netHud(): string {
  if (netMode !== "online" || !net || !predictor) {
    return `net: ${netMode} ${netNote}`;
  }
  const st = net.stats;
  return (
    `net: online #${net.playerId} | ping ${st.rttMs.toFixed(0)} ms ±${st.jitterMs.toFixed(0)} | ` +
    `${st.snapshotsPerSecond} snap/s | server queue ${st.queued} | unacked ${predictor.pending}\n` +
    `prediction: ${predictor.corrections} corrections, worst ${(predictor.maxError * 100).toFixed(1)} cm | ` +
    `${remotes.ids().length} remote | interp ${(INTERP_TICKS * 1000) / TICK_RATE} ms ${netNote}`
  );
}

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
  smoother.update(frameDt);
  cam.position.set(
    lerp(prevPlayer.x, player.x, alpha) + smoother.x,
    lerp(prevPlayer.y, player.y, alpha) + eye + smoother.y,
    lerp(prevPlayer.z, player.z, alpha) + smoother.z,
  );

  // Other players: where they were INTERP_TICKS ago, interpolated between snapshots.
  const renderTick = clock.tickAt(nowMs) - INTERP_TICKS;
  remoteViews.update(
    clock.ready
      ? remotes.ids().flatMap((id) => {
          const pose = remotes.sample(id, renderTick);
          return pose ? [pose] : [];
        })
      : [],
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
    `render ${RENDER_WIDTH}x${RENDER_HEIGHT} (?res=240..720) | sim ticks ${simTicks}\n` +
    netHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
