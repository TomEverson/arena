import * as THREE from "three";

import greybox from "../../levels/greybox.json";
import { AudioEngine, type MoveSound, MoveSoundTracker, StepCounter } from "./audio";
import { type BodyState, CharacterBody } from "./character";
import {
  aliveHitboxes,
  type Dummy,
  DUMMY_HEIGHT,
  killDummy,
  makeDummies,
  resetDummies,
  stepDummies,
} from "./dummies";
import { DummyViews } from "./dummyView";
import { Fx } from "./fx";
import { HitFeedback } from "./hitFeedback";
import { CombatHud } from "./hud";
import { buildLevelMeshes } from "./levelRender";
import { levelByName } from "./levels";
import { FixedTimestep, TICK_RATE } from "./loop";
import { MatchHud } from "./matchHud";
import { canAct } from "./matchui";
import { NetClient } from "./net/client";
import { ServerClock } from "./net/clock";
import { EventTracker } from "./net/events";
import { INTERP_TICKS, RemoteTracks } from "./net/interpolation";
import { Predictor } from "./net/prediction";
import {
  EntityFlags,
  EventKinds,
  type GameEvent,
  GameEventFlags,
  type MatchInfo,
  type PlayerHealth,
  type Score,
} from "./net/protocol.gen";
import {
  closeReason,
  createRoom,
  type GameMode,
  modeFromUrl,
  roomFromUrl,
  roomLink,
} from "./net/rooms";
import { CorrectionSmoother } from "./net/smoothing";
import { PALETTE } from "./palette";
import { PracticeStats } from "./practiceStats";
import { RemoteViews } from "./remoteView";
import { RENDER_HEIGHT, RENDER_WIDTH, RetroRenderer } from "./render";
import { castRay, type Hitbox } from "./sim/hitscan";
import { buildCollisionWorld, type Level, parseLevel } from "./sim/level";
import { bodyHeight, eyeHeight, hSpeed, spawnState, stepPlayer } from "./sim/movement";
import { COMBAT, PARAMS, WEAPON } from "./sim/params";
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
// The level starts as the greybox (also the offline practice course); online, the server's
// welcome names the room's map and `useLevel` swaps to it before the first snapshot.
let level = parseLevel(greybox);
let world = buildCollisionWorld(level);

const scene = new THREE.Scene();
scene.background = PALETTE.HAZE;
scene.fog = new THREE.Fog(PALETTE.HAZE, 30, 90);
let levelMeshes = buildLevelMeshes(level);
scene.add(levelMeshes);
scene.add(new THREE.HemisphereLight(PALETTE.BONE, PALETTE.GRAPHITE, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(20, 40, 10);
scene.add(sun);

/** Switch to another map: new collision world and new meshes (the old ones are dropped). */
function useLevel(next: Level): void {
  level = next;
  world = buildCollisionWorld(level);
  scene.remove(levelMeshes);
  // Free the old geometry (materials are shared between maps, so they stay).
  levelMeshes.traverse((o) => {
    if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
  });
  levelMeshes = buildLevelMeshes(level);
  scene.add(levelMeshes);
}

const view = new RetroRenderer(canvas, scene);
window.addEventListener("resize", () => view.resize());

const HIP_FOV = 75;
const HITSTOP_TICKS = 4; // about 67 ms: dummies freeze when one dies

const dummies: Dummy[] = makeDummies(level.targets);
const dummyViews = new DummyViews(scene, dummies);

// Your own body is the Dummy too, seen from inside: no head, arms or rifle (the viewmodel has
// those), just the torso and legs you see when you look down, in every pose the body has.
/** How far behind the camera your own body is drawn (metres). */
const SELF_BODY_BACK = 0.25;
/** Your body shows when the camera pitch is below this (radians, negative = looking down). */
const SELF_BODY_SHOW_PITCH = -0.45;
const selfBody = new CharacterBody(scene, 99);
let selfBodyShown = false;
selfBody.setFirstPerson(true);
const selfState: BodyState = {
  x: 0,
  y: 0,
  z: 0,
  onGround: true,
  sliding: false,
  alive: true,
  armed: true,
};
const fx = new Fx(scene, view.camera);
const hitFeedback = new HitFeedback();
const ammoEl = document.getElementById("ammo") as HTMLDivElement;

const DT = 1 / TICK_RATE;

// --- Player ----------------------------------------------------------------
const spawn = level.spawnZones[0];
const spawnPos = spawn ? spawn.pos : ([0, 0, 0] as const);
let player: PlayerState = spawnState(spawnPos[0], spawnPos[1], spawnPos[2]);
let prevPlayer: PlayerState = player;
const look = { yaw: 0, pitch: 0 }; // yaw 0 faces -Z, toward the arena centre from spawn zone 0

// --- Audio -----------------------------------------------------------------
const audio = new AudioEngine();
const moveSounds = new MoveSoundTracker();
const moveOut: MoveSound[] = [];
const remoteSteps = new Map<number, StepCounter>();
// Browsers allow sound only after the player interacts with the page.
for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => audio.unlock());

/** The sounds for one weapon step: shot, dry click, reload start and finish. */
function shotSounds(shot: ShotResult): void {
  if (shot.fired) audio.shot();
  if (shot.dryFire) audio.dryFire();
  if (shot.reloadStarted) audio.reloadStart();
  if (shot.reloadFinished) audio.reloadDone();
}

// --- Input -----------------------------------------------------------------
const held = new Set<string>();
const pressed = { jump: false, dash: false, reload: false };

window.addEventListener("keydown", (e) => {
  if (e.code === "Tab") e.preventDefault(); // Tab shows the scoreboard, not the browser's focus ring
  if (e.repeat) return;
  held.add(e.code);
  if (e.code === "Space") pressed.jump = true;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") pressed.dash = true;
  if (e.code === "KeyR") pressed.reload = true;
  if (e.code === "Enter") net?.sendRematch(); // only counts while the results are showing
  if (e.code === "KeyL") copyInviteLink();
  if (e.code === "KeyM") audio.toggleMute();
  if (e.code === "KeyK") practiceReset();
  if (e.code === "KeyH") practiceRefill();
  if (e.code === "KeyT") practiceStart();
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
const lockPointer = () => void canvas.requestPointerLock();
hint.addEventListener("click", lockPointer);
canvas.addEventListener("click", lockPointer);
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
const events = new EventTracker();
const combatHud = new CombatHud(
  (kind) => fx.hitMarker(kind),
  (e) => showServerHit(e),
);
const matchHud = new MatchHud();
const roomInfoEl = document.getElementById("roominfo") as HTMLDivElement;
let health: PlayerHealth | null = null;
let match: MatchInfo | null = null;
let scores: Score[] = [];
let roomCode = "";
let myId = -1;
let roomNote = "";
let gameMode: GameMode = "ffa"; // the room's mode, from the server's welcome
const practiceStats = new PracticeStats();
const practiceEl = document.getElementById("practice") as HTMLDivElement;
const menuEl = document.getElementById("menu") as HTMLDivElement;
const menuNote = document.getElementById("menu-note") as HTMLDivElement;

/** Practice tools and the stats panel are on in the practice range, and in offline mode (local dummies). */
const inRange = () => (netMode === "online" ? gameMode === "practice" : netMode === "offline");

/** K: reset the targets and the stats. */
function practiceReset(): void {
  if (!inRange()) return;
  practiceStats.reset();
  if (netMode === "online") net?.sendPractice("reset");
  else resetDummies(dummies);
}

/** H: refill health and ammo. */
function practiceRefill(): void {
  if (!inRange()) return;
  if (netMode === "online") net?.sendPractice("refill");
  else weapon = spawnWeapon(1);
}

/** T: back to the start of the movement course. */
function practiceStart(): void {
  if (!inRange()) return;
  if (netMode === "online") {
    net?.sendPractice("start");
  } else {
    player = spawnState(spawnPos[0], spawnPos[1], spawnPos[2]);
    prevPlayer = player;
  }
}

function practiceHtml(): string {
  const s = practiceStats;
  const secs = (v: number | null) => (v === null ? "–" : `${v.toFixed(2)}s`);
  return (
    `<b>${netMode === "offline" ? "PRACTICE (offline)" : "PRACTICE RANGE"}</b><br>` +
    `shots ${s.shots}  hits ${s.hits}  accuracy <b>${(s.accuracy * 100).toFixed(0)}%</b><br>` +
    `headshots ${s.headshots} (${(s.headshotShare * 100).toFixed(0)}%)  damage ${Math.round(s.damage)}<br>` +
    `kills ${s.kills}  TTK last <b>${secs(s.lastTtk)}</b>  avg ${secs(s.averageTtk)}  best ${secs(s.bestTtk)}` +
    `<div class="keys">K reset targets + stats · H refill · T course start</div>`
  );
}

/** The link a friend opens to join this room (no other query parameters). */
const inviteLink = () => (roomCode ? roomLink(location.origin, location.pathname, roomCode) : "");

function copyInviteLink(): void {
  const link = inviteLink();
  if (!link) return;
  navigator.clipboard.writeText(link).then(
    () => (roomNote = "Link copied!"),
    () => (roomNote = `Copy failed: ${link}`),
  );
  setTimeout(() => (roomNote = ""), 2500);
}
roomInfoEl.addEventListener("click", (e) => {
  e.stopPropagation(); // clicking the link area should not start the game
  if ((e.target as HTMLElement).id === "copylink") copyInviteLink();
});

/** A server-confirmed hit: show the target's health bar and a damage number over where they are on screen. */
function showServerHit(e: GameEvent): void {
  const now = performance.now();
  practiceStats.onHit({
    targetId: e.other,
    damage: e.amount,
    headshot: (e.flags & GameEventFlags.headshot) !== 0,
    killed: (e.flags & GameEventFlags.killed) !== 0,
    tick: e.tick,
  });
  remoteViews.flash(e.other);
  audio.hit((e.flags & GameEventFlags.headshot) !== 0, (e.flags & GameEventFlags.killed) !== 0);
  hitFeedback.onHit(
    {
      targetId: e.other,
      health: e.health,
      shield: e.shield,
      damage: e.amount,
      headshot: (e.flags & GameEventFlags.headshot) !== 0,
      killed: (e.flags & GameEventFlags.killed) !== 0,
    },
    now,
  );
}

/** How far above the top of a head the health bar sits (metres), a little clear of it. */
const HEAD_GAP = 0.15;

/** Where a target's head is on screen right now (for the marker that follows them), or null. */
function headAnchor(id: number): { x: number; y: number } | null {
  if (netMode === "offline") {
    const d = dummies[id];
    return d ? view.toScreen(d.x, d.y + DUMMY_HEIGHT + HEAD_GAP, d.z) : null;
  }
  const pose = clock.ready
    ? remotes.sample(id, clock.tickAt(performance.now()) - INTERP_TICKS)
    : null;
  if (!pose) return null;
  const height = pose.flags & EntityFlags.crouching ? PARAMS.crouchHeight : PARAMS.standHeight;
  return view.toScreen(pose.x, pose.y + height + HEAD_GAP, pose.z);
}

function goOffline(note: string): void {
  netMode = "offline";
  netNote = note;
  net = null;
  predictor = null;
  health = null;
  match = null;
  scores = [];
}

function startNet(code: string): void {
  roomCode = code;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  net = new NetClient(`${proto}//${location.host}/ws?room=${encodeURIComponent(code)}`, {
    onWelcome(w) {
      myId = w.playerId;
      roomCode = w.room;
      combatHud.setPlayerId(w.playerId);
      gameMode = w.mode === "practice" ? "practice" : "ffa";
      if (w.level !== level.name) {
        const next = levelByName(w.level);
        if (next) useLevel(next);
        else netNote = `WARNING: server runs "${w.level}", client has no such map`;
      }
    },
    onSnapshot(s) {
      clock.onSnapshot(s.tick, performance.now());
      remotes.push(s.tick, s.entities);
      health = s.health;
      match = s.match;
      scores = s.scores;
      for (const e of events.fresh(s.events)) {
        combatHud.onEvent(e);
        if (e.kind === EventKinds.hurt && e.other === myId) audio.hurt(e.amount);
        if (e.kind === EventKinds.kill && e.other === myId) audio.death();
      }
      // We only simulate while alive and while the match lets players act (not in the countdown or results).
      const acting = s.health.alive && canAct(s.match.phase);
      if (!predictor) {
        // First snapshot: start from wherever the server put us.
        predictor = new Predictor(world, s.you, s.ackSeq, DT, s.weapon);
        predictor.alive = acting;
        player = prevPlayer = predictor.state;
        netMode = "online";
        return;
      }
      const correction = predictor.reconcile(s.ackSeq, s.you, s.weapon, acting);
      if (correction) smoother.onCorrection(correction);
      player = predictor.state;
    },
    onClose(wasConnected, closeCode) {
      const why = closeReason(closeCode);
      if (why) {
        roomInfoEl.innerHTML = `<span class="err">${why}</span> <a href="${location.pathname}">Start a new room</a>`;
        goOffline(why);
      } else {
        goOffline(wasConnected ? "connection lost: offline mode" : "no server: offline mode");
      }
    },
  });
}

/** Make a room of this mode, put its link in the address bar to share, and join it. */
async function startRoom(mode: GameMode): Promise<void> {
  menuEl.classList.remove("on");
  try {
    const code = (await createRoom(mode)).code;
    const url = new URL(location.href);
    url.searchParams.set("room", code);
    url.searchParams.delete("mode");
    history.replaceState(null, "", url);
    startNet(code);
  } catch {
    goOffline("no server: offline mode");
    menuNote.textContent = "";
  }
}

document.getElementById("play-ffa")?.addEventListener("click", () => void startRoom("ffa"));
document
  .getElementById("play-practice")
  ?.addEventListener("click", () => void startRoom("practice"));

if (new URLSearchParams(location.search).has("offline")) {
  netMode = "offline";
  netNote = "(?offline)";
} else {
  const code = roomFromUrl(location.search);
  const mode = modeFromUrl(location.search);
  if (code)
    startNet(code); // a room link: straight in
  else if (mode)
    void startRoom(mode); // ?mode=practice: skip the menu
  else menuEl.classList.add("on"); // otherwise choose
}

// --- Simulation ------------------------------------------------------------
let simTicks = 0;
let weapon = spawnWeapon(1);
let shotsFired = 0;
let hitstopTicks = 0;
let killLog = "no kills yet";

/** Other players as the local screen currently draws them (effects only: the server decides hits). */
function remoteHitboxes(renderTick: number): Hitbox[] {
  const boxes: Hitbox[] = [];
  for (const id of remotes.ids()) {
    const pose = remotes.sample(id, renderTick);
    if (!pose || (pose.flags & EntityFlags.dead) !== 0) continue;
    const height =
      pose.flags & EntityFlags.sliding
        ? PARAMS.slideHeight
        : pose.flags & EntityFlags.crouching
          ? PARAMS.crouchHeight
          : PARAMS.standHeight;
    boxes.push({
      id,
      headMinY: pose.y + height - COMBAT.headSize,
      minX: pose.x - PARAMS.halfWidth,
      maxX: pose.x + PARAMS.halfWidth,
      minY: pose.y,
      maxY: pose.y + height,
      minZ: pose.z - PARAMS.halfWidth,
      maxZ: pose.z + PARAMS.halfWidth,
    });
  }
  return boxes;
}

/**
 * Online: the shot itself (spread, recoil, ammo) is predicted, so the tracer, muzzle flash and
 * view kick are immediate. Whether it hit someone is the server's call: hit markers come from events.
 */
function fireShotOnline(shot: ShotResult, ads: boolean): void {
  const origin: [number, number, number] = [player.x, player.y + eyeHeight(player), player.z];
  const dir = viewDirection(look.yaw + shot.spreadYaw, look.pitch + shot.spreadPitch);
  const targets = remoteHitboxes(clock.tickAt(performance.now()) - INTERP_TICKS);
  const hit = castRay(world, targets, origin, dir);
  fx.shot(new THREE.Vector3(hit.x, hit.y, hit.z), hit.kind === "world", ads);
  look.yaw += shot.kickYaw;
  look.pitch = clampPitch(look.pitch + shot.kickPitch);
}

function fireShot(shot: ShotResult, ads: boolean): void {
  shotsFired++;
  practiceStats.onShot();
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
    practiceStats.onHit({
      targetId: d.id,
      damage: damageFor(hit.headshot),
      headshot: hit.headshot,
      killed: result.killed,
      tick: simTicks,
    });
    dummyViews.flash(d.id);
    audio.hit(hit.headshot, result.killed);
    hitFeedback.onHit(
      {
        targetId: d.id,
        health: d.health,
        shield: d.shield,
        damage: damageFor(hit.headshot),
        headshot: hit.headshot,
        killed: result.killed,
      },
      performance.now(),
    );
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
    fire: held.has("Mouse0"),
    reload: pressed.reload,
  };
  prevPlayer = player;
  if (predictor) {
    // Online: predict now (movement and weapon), tell the server (the last few inputs, so a lost
    // message loses nothing). viewTick says which moment of the world our screen is showing.
    const viewTick = clock.ready ? clock.tickAt(performance.now()) - INTERP_TICKS : 0;
    predictor.step(input, look.pitch, viewTick);
    player = predictor.state;
    net?.sendInputs(predictor.recent());
    if (predictor.lastShot) shotSounds(predictor.lastShot);
    if (predictor.lastShot?.fired) {
      practiceStats.onShot();
      fireShotOnline(predictor.lastShot, ads);
    }
  } else if (netMode === "offline") {
    // Offline practice: local movement, local weapon, local dummies.
    player = stepPlayer(player, input, world, DT);
    stepDummies(dummies, DT, hitstopTicks > 0);
    if (hitstopTicks > 0) hitstopTicks--;
    const res = stepWeapon(
      weapon,
      input,
      {
        hSpeed: hSpeed(player),
        onGround: player.onGround,
        crouching: player.crouching,
        sliding: player.sliding,
      },
      DT,
    );
    weapon = res.state;
    shotSounds(res.shot);
    if (res.shot.fired) fireShot(res.shot, ads);
  } // else: still connecting, wait for the first snapshot

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
    `room ${roomCode} | ${remotes.ids().length} remote | interp ${(INTERP_TICKS * 1000) / TICK_RATE} ms ${netNote}`
  );
}

// --- Render ----------------------------------------------------------------
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
let eye = PARAMS.standEye;
let lastFrame = 0;

/** How far the camera banks away from the wall while wall running (radians, about 4 degrees). */
const WALL_ROLL = 0.07;
let camRoll = 0;

/** Movement sounds for you, footsteps for everyone else, and where the listener is. */
function updateSound(frameDt: number, renderTick: number, cam: THREE.PerspectiveCamera): void {
  audio.setListener(cam.position.x, cam.position.y, cam.position.z, look.yaw, look.pitch);
  if (health === null || health.alive) {
    moveOut.length = 0;
    moveSounds.update(player, frameDt, moveOut);
    for (const m of moveOut) audio.move(m, moveSounds.landStrength);
  }
  if (netMode !== "online" || !clock.ready) return;
  const ids = new Set(remotes.ids());
  for (const id of ids) {
    const pose = remotes.sample(id, renderTick);
    if (!pose || pose.flags & EntityFlags.dead) continue;
    let counter = remoteSteps.get(id);
    if (!counter) remoteSteps.set(id, (counter = new StepCounter()));
    if (counter.update(pose.x, pose.y, pose.z)) audio.move("step", 1, pose);
  }
  for (const id of remoteSteps.keys()) if (!ids.has(id)) remoteSteps.delete(id);
}

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
  const dead = health !== null && !health.alive;
  eye += ((dead ? 0.35 : eyeHeight(player)) - eye) * (1 - Math.exp(-frameDt * 18));
  smoother.update(frameDt);
  cam.position.set(
    lerp(prevPlayer.x, player.x, alpha) + smoother.x,
    lerp(prevPlayer.y, player.y, alpha) + eye + smoother.y,
    lerp(prevPlayer.z, player.z, alpha) + smoother.z,
  );

  // The body sits a little behind the camera, so looking down shows the chest edge and legs
  // instead of the top of the shoulders filling the screen.
  selfState.x = cam.position.x + Math.sin(look.yaw) * SELF_BODY_BACK;
  selfState.y = lerp(prevPlayer.y, player.y, alpha) + smoother.y;
  selfState.z = cam.position.z + Math.cos(look.yaw) * SELF_BODY_BACK;
  selfState.onGround = player.onGround;
  selfState.sliding = player.sliding;
  selfState.crouching = player.crouching;
  selfState.dashing = player.dashTime > 0;
  selfState.wallRunning = player.wallRunning;
  selfState.alive = !dead;
  selfState.aiming = adsHeld;
  selfState.yaw = look.yaw + Math.PI; // the figure faces +Z, the camera looks down -Z at yaw 0
  selfBody.update(selfState, frameDt, cam.position);
  // Only show your body when you look down at it (or when dead): sliding, crouching, dashing
  // and wall running pose it in ways that would otherwise put legs and torso in the way of the
  // view while you look ahead. A little hysteresis stops it flickering at the edge.
  selfBodyShown = look.pitch < (selfBodyShown ? SELF_BODY_SHOW_PITCH + 0.05 : SELF_BODY_SHOW_PITCH);
  selfBody.root.visible = selfBodyShown || dead;

  // Other players: where they were INTERP_TICKS ago, interpolated between snapshots.
  const renderTick = clock.tickAt(nowMs) - INTERP_TICKS;
  remoteViews.update(
    clock.ready
      ? remotes.ids().flatMap((id) => {
          const pose = remotes.sample(id, renderTick);
          return pose ? [pose] : [];
        })
      : [],
    frameDt,
    cam.position,
  );
  updateSound(frameDt, renderTick, cam);
  const activeWeapon = predictor ? predictor.weapon : weapon;
  const spread = spreadDegrees(activeWeapon.burst, adsHeld, {
    hSpeed: hSpeed(player),
    onGround: player.onGround,
    crouching: player.crouching,
    sliding: player.sliding,
  });
  const shake = fx.update(
    frameDt,
    adsT,
    spread,
    fov,
    activeWeapon.reloadT,
    activeWeapon.ammo / WEAPON.magSize,
  );
  // Wall run: bank the camera away from the wall (positive roll tilts the head left).
  const wallOnRight =
    -player.wallNormalX * Math.cos(look.yaw) + player.wallNormalZ * Math.sin(look.yaw);
  const rollTarget =
    player.wallRunning && health?.alive !== false ? Math.sign(wallOnRight) * WALL_ROLL : 0;
  camRoll += (rollTarget - camRoll) * (1 - Math.exp(-frameDt * 10));
  cam.rotation.set(look.pitch + shake.pitch, look.yaw + shake.yaw, camRoll);
  if (netMode === "offline") dummyViews.update(dummies, frameDt, cam.position);
  else dummyViews.hideAll(); // online, the targets are other players
  const inMatch = match !== null && canAct(match.phase);
  combatHud.update(netMode === "online" ? health : null, inMatch);
  matchHud.update(
    netMode === "online" && gameMode === "ffa" ? match : null,
    scores,
    myId,
    held.has("Tab"),
    inviteLink(),
  );
  if (netMode === "online" && !roomInfoEl.querySelector(".err")) {
    const html =
      `${gameMode === "practice" ? "Practice range" : "FFA"} · Room <b>${roomCode}</b> · ${match?.players ?? 0} player${match?.players === 1 ? "" : "s"} ` +
      `<button id="copylink">Copy invite link</button>${roomNote ? ` ${roomNote}` : ""}<br>${inviteLink()}`;
    if (roomInfoEl.innerHTML !== html) roomInfoEl.innerHTML = html;
  }
  hitFeedback.update(nowMs, headAnchor);
  practiceEl.classList.toggle("on", inRange());
  if (inRange()) practiceEl.innerHTML = practiceHtml();
  ammoEl.innerHTML = `${activeWeapon.ammo} / ${WEAPON.magSize}<small>${
    activeWeapon.reloadT > 0
      ? `RELOADING ${activeWeapon.reloadT.toFixed(1)}s`
      : activeWeapon.ammo === 0
        ? "RELOAD (R)"
        : ""
  }</small>`;
  view.render();

  const state = [
    dead ? "DEAD" : "",
    player.onGround ? "ground" : "air",
    player.sliding ? "slide" : "",
    player.crouching ? "crouch" : "",
    player.climbing ? "climb" : "",
    player.dashTime > 0 ? "dash" : "",
    player.mantling ? "mantle" : "",
    player.wallRunning ? "wallrun" : "",
  ]
    .filter(Boolean)
    .join(" ");
  hud.textContent =
    `speed ${hSpeed(player).toFixed(1)} m/s | ${state} | height ${bodyHeight(player).toFixed(1)}\n` +
    `jumps ${"●".repeat(player.airJumps)}${"○".repeat(PARAMS.maxAirJumps - player.airJumps)}  dash ${"●".repeat(Math.floor(player.dashCharges))}${"○".repeat(PARAMS.dashCharges - Math.floor(player.dashCharges))}  ` +
    `(${(player.dashCharges % 1).toFixed(2)})\n` +
    `${killLog}\n` +
    `WASD move · Space jump (hold at green walls to climb; beside any other wall at speed you run along it, jump again to kick off) · Shift dash · C crouch/slide · LMB fire · RMB aim · R reload · Tab scoreboard · Enter rematch · L copy link · P respawn (dev)\n` +
    `render ${RENDER_WIDTH}x${RENDER_HEIGHT} (?res=240..720) | sim ticks ${simTicks}\n` +
    netHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
