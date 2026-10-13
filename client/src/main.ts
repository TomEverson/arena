import * as THREE from "three";

import greybox from "../../levels/greybox.json";
import { AudioEngine, type MoveSound, MoveSoundTracker, StepCounter } from "./audio";
import { type BodyState, CharacterBody, HERO_LOOKS, HERO_NAMES } from "./character";
import { loadCharacterModels } from "./characterModels";
import { Fx } from "./fx";
import { HitFeedback } from "./hitFeedback";
import { CombatHud } from "./hud";
import { buildLevelDecor } from "./levelDecor";
import { buildLevelMeshes } from "./levelRender";
import { levelByName } from "./levels";
import { FixedTimestep, TICK_RATE } from "./loop";
import { MatchHud } from "./matchHud";
import { canAct } from "./matchui";
import { NetClient } from "./net/client";
import { ServerClock } from "./net/clock";
import { EventTracker, ShotTracker } from "./net/events";
import { interpolationTicks, RemoteTracks } from "./net/interpolation";
import { Predictor } from "./net/prediction";
import {
  EntityFlags,
  EntityKinds,
  EventKinds,
  type GameEvent,
  GameEventFlags,
  HeroKinds,
  type MatchInfo,
  type PlayerHealth,
  type Score,
  type Shot,
} from "./net/protocol.gen";
import {
  closeReason,
  createRoom,
  type GameMode,
  modeFromUrl,
  roomFromUrl,
  roomLink,
} from "./net/rooms";
import { CorrectionSmoother, SMOOTH_TIME, SNAP_DISTANCE } from "./net/smoothing";
import { PALETTE } from "./palette";
import { PracticeStats } from "./practiceStats";
import { RemoteViews } from "./remoteView";
import { RENDER_HEIGHT, RENDER_WIDTH, RetroRenderer } from "./render";
import { castRay, type Hitbox } from "./sim/hitscan";
import { buildCollisionWorld, type Level, parseLevel } from "./sim/level";
import { bodyHeight, eyeHeight, hSpeed, spawnState } from "./sim/movement";
import { COMBAT, PARAMS, SKILL } from "./sim/params";
import { emptyInput, type PlayerState } from "./sim/types";
import {
  activeDef,
  EMPTY_HANDS,
  LOADOUTS,
  type ShotResult,
  spawnWeapon,
  spreadDegrees,
  viewDirection,
  WEAPON_DEFS,
  type WeaponState,
} from "./sim/weapon";
import { type GrappleLine, isSkillPose, SkillViews } from "./skillView";

// Blockbench character models: loaded before any character is made (see characterModels.ts).
await loadCharacterModels();

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLDivElement;

// --- Level -----------------------------------------------------------------
// The level starts as the greybox; once connected, the server's
// welcome names the room's map and `useLevel` swaps to it before the first snapshot.
let level = parseLevel(greybox);
let world = buildCollisionWorld(level);

const scene = new THREE.Scene();
// Haze, not a wall: clear out to 100 m, then thickening slowly, so a player across the 200 m map
// (283 m corner to corner, inside the sniper's 250 m range) is still plainly visible.
const fog = new THREE.Fog(PALETTE.HAZE, 100, 500);
scene.fog = fog;
const skyLight = new THREE.HemisphereLight(PALETTE.BONE, PALETTE.GRAPHITE, 1.2);
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
scene.add(skyLight, sun);
/** The night sky's colour: between INK and GRAPHITE, so roofs and towers still stand out against it. */
const NIGHT = PALETTE.INK.clone().lerp(PALETTE.GRAPHITE, 0.45);

/**
 * The sky, fog and lights for a level's `sky`: day (the default) or "night". Night is moonlit,
 * not dark: the world drops about a step down the palette, the sky goes nearly black, and the
 * light strips and lamps (which are unlit) are what stands out. Players must still be easy to see.
 */
function applySky(sky: string | undefined): void {
  const night = sky === "night";
  scene.background = night ? NIGHT : PALETTE.HAZE;
  fog.color.copy(night ? NIGHT : PALETTE.HAZE);
  fog.near = night ? 70 : 100;
  fog.far = night ? 420 : 500;
  skyLight.color.copy(night ? PALETTE.HAZE : PALETTE.BONE);
  skyLight.groundColor.copy(night ? PALETTE.INK : PALETTE.GRAPHITE);
  skyLight.intensity = night ? 0.85 : 1.2;
  sun.intensity = night ? 0.75 : 1.5; // the moon
  if (night) sun.position.set(-30, 40, -18);
  else sun.position.set(20, 40, 10);
}

/** A level's meshes: what you can touch, and its looks-only extras. */
function buildLevel(l: Level): THREE.Group {
  const group = buildLevelMeshes(l);
  group.add(buildLevelDecor(l));
  return group;
}
let levelMeshes = buildLevel(level);
scene.add(levelMeshes);
applySky(level.sky);

/** Switch to another map: new collision world and new meshes (the old ones are dropped). */
function useLevel(next: Level): void {
  level = next;
  world = buildCollisionWorld(level);
  scene.remove(levelMeshes);
  // Free the old geometry (materials are shared between maps, so they stay).
  levelMeshes.traverse((o) => {
    if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
  });
  levelMeshes = buildLevel(level);
  scene.add(levelMeshes);
  applySky(level.sky);
}

const view = new RetroRenderer(canvas, scene);
window.addEventListener("resize", () => view.resize());

const FOV_KEY = "arena.fov";
const readFov = (): number => {
  const value = Number(localStorage.getItem(FOV_KEY));
  return Number.isFinite(value) ? Math.max(60, Math.min(120, value)) : 75;
};
let hipFov = readFov();
const fovSettings = document.getElementById("fov-settings") as HTMLDivElement;
const fovRange = document.getElementById("fov-range") as HTMLInputElement;
const fovValue = document.getElementById("fov-value") as HTMLSpanElement;
const resolutionValue = document.getElementById("resolution-value") as HTMLSelectElement;
const aspectValue = document.getElementById("aspect-value") as HTMLSelectElement;
resolutionValue.value = localStorage.getItem("arena.res") ?? "720";
aspectValue.value = localStorage.getItem("arena.aspect") ?? "16:9";
const reloadDisplay = (): void => {
  localStorage.setItem("arena.res", resolutionValue.value);
  localStorage.setItem("arena.aspect", aspectValue.value);
  location.reload();
};
resolutionValue.addEventListener("change", reloadDisplay);
aspectValue.addEventListener("change", reloadDisplay);
const setFov = (value: number): void => {
  hipFov = Math.max(60, Math.min(120, value));
  fovRange.value = String(hipFov);
  fovValue.textContent = `${hipFov}°`;
  localStorage.setItem(FOV_KEY, String(hipFov));
};
setFov(hipFov);
fovRange.addEventListener("input", () => setFov(Number(fovRange.value)));
fovSettings.addEventListener("click", (e) => e.stopPropagation());

// Your own body is the Dummy too, seen from inside: no head, arms or rifle (the viewmodel has
// those), just the torso and legs you see when you look down, in every pose the body has.
/** How far behind the camera your own body is drawn (metres). */
const SELF_BODY_BACK = 0.25;
/** Your body shows when the camera pitch is below this (radians, negative = looking down). */
const SELF_BODY_SHOW_PITCH = -0.45;
let selfBody = new CharacterBody(scene, 99);
let selfBodyShown = false;
selfBody.setFirstPerson(true);
/** The hero our own body is built as (a HeroKinds value). */
let selfHero: number = HeroKinds.trooper;
/** We became another hero: rebuild the body you see when you look down. */
function useSelfHero(hero: number): void {
  if (hero === selfHero) return;
  selfHero = hero;
  fx.setBlades(hero === HeroKinds.assassin);
  scene.remove(selfBody.root);
  selfBody = new CharacterBody(scene, 99, HERO_LOOKS[hero] ?? "trooper");
  selfBody.setFirstPerson(true);
}
const selfState: BodyState = {
  x: 0,
  y: 0,
  z: 0,
  onGround: true,
  sliding: false,
  alive: true,
  armed: true,
};
const fx = new Fx(scene, view.camera, view.viewScene, view.viewCamera);
const hitFeedback = new HitFeedback();
const ammoEl = document.getElementById("ammo") as HTMLDivElement;
const slotsEl = document.getElementById("slots") as HTMLDivElement;
const skillsEl = document.getElementById("skills") as HTMLDivElement;

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

/** How long the reload in progress takes in all (seconds), for its animation; 0 before the first. */
let reloadTotal = 0;

/** The sounds for one weapon step: shot, dry click, reload start and finish. */
function shotSounds(shot: ShotResult): void {
  if (shot.fired) {
    const d = currentDef();
    if (d === WEAPON_DEFS[1]) audio.shotSniper();
    else if (d?.spear) audio.skill();
    else audio.shot();
  }
  if (shot.switched) {
    const w = currentWeapon();
    audio.draw();
    fx.setWeapon(w.gun, w.slot !== EMPTY_HANDS, w.switchT);
    syncedGun = w.gun * 10 + (w.slot !== EMPTY_HANDS ? 1 : 0);
  }
  if (shot.dryFire) audio.dryFire();
  if (shot.reloadStarted) {
    audio.reloadStart();
    reloadTotal = currentWeapon().reloadT; // how long this reload takes (shorter in overdrive)
  }
  if (shot.reloadFinished) audio.reloadDone();
  if (shot.meleeStarted) {
    audio.swing();
    fx.melee();
  }
  if (shot.grenade || shot.barrier) audio.skill();
  // The dash cut: the press starts the draw and the X; the dash comes when the wind-up is over.
  if (shot.slashStarted) {
    audio.swing();
    fx.slash();
  }
  if (shot.slash) audio.swing();
  // The rolling dive: the press starts the draw; the dive comes when the wind-up is over.
  if (shot.rollStarted) {
    audio.swing();
    fx.rollPrep();
  }
  if (shot.roll) {
    audio.swing();
    fx.roll();
  }
}

/** About how long until your own dive ends (seconds): when it reaches a wall or the floor, or its time runs out. */
function diveLeft(): number {
  const hit = castRay(
    world,
    [],
    [player.x, player.y + 0.05, player.z],
    [player.rollDirX, player.rollDirY, player.rollDirZ],
    SKILL.rollSpeed * player.rollT,
  );
  return hit.t / SKILL.rollSpeed;
}

/** The weapon state the player is using right now (predicted; a fresh one until the server has answered). */
function currentWeapon(): WeaponState {
  return predictor ? predictor.weapon : weapon;
}
/** The gun in hand, or null for empty hands. */
const currentDef = () => activeDef(currentWeapon());
/** What the viewmodel is showing (gun * 10 + 1 if held): kept in step with the weapon state each frame. */
let syncedGun = 1;

// --- Input -----------------------------------------------------------------
const held = new Set<string>();
const pressed = {
  jump: false,
  dash: false,
  reload: false,
  melee: false,
  slot: 0,
  skillQ: false,
  skillE: false,
  ult: false,
};

window.addEventListener("keydown", (e) => {
  if (e.code === "Tab") e.preventDefault(); // Tab shows the scoreboard, not the browser's focus ring
  if (e.repeat) return;
  held.add(e.code);
  if (e.code === "Space") pressed.jump = true;
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") pressed.dash = true;
  if (e.code === "KeyR") pressed.reload = true;
  if (e.code === "KeyV") pressed.melee = true;
  if (e.code === "KeyQ") pressed.skillQ = true;
  if (e.code === "KeyE") pressed.skillE = true;
  if (e.code === "KeyF") pressed.ult = true;
  if (e.code === "Digit1") pressed.slot = 1;
  if (e.code === "Digit2") pressed.slot = 2;
  if (e.code === "Digit3") pressed.slot = 3;
  if (e.code === "Enter") net?.sendRematch(); // only counts while the results are showing
  if (e.code === "KeyL") copyInviteLink();
  if (e.code === "KeyM") audio.toggleMute();
  if (e.code === "KeyK") practiceReset();
  if (e.code === "KeyH") practiceRefill();
  if (e.code === "KeyT") practiceStart();
  if (e.code === "KeyP") {
    net?.sendRespawn(); // the server owns our position; the snapshot corrects us
  }
});
window.addEventListener("keyup", (e) => held.delete(e.code));

// Apex-like baseline at sensitivity 1.00. The setting below scales this without changing ADS ratios.
const MOUSE_SENS = 0.0011;
const SENSITIVITY_KEY = "arena.sensitivity";
const SENSITIVITY_MIN = 0.25;
const SENSITIVITY_MAX = 3;
const sensitivityRange = document.getElementById("sensitivity-range") as HTMLInputElement;
const sensitivityValue = document.getElementById("sensitivity-value") as HTMLInputElement;
const readSensitivity = (): number => {
  const value = Number(localStorage.getItem(SENSITIVITY_KEY));
  return Number.isFinite(value) ? Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, value)) : 1;
};
let sensitivity = readSensitivity();
const setSensitivity = (value: number): void => {
  sensitivity = Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, value));
  const display = sensitivity.toFixed(2);
  sensitivityRange.value = display;
  sensitivityValue.value = display;
  localStorage.setItem(SENSITIVITY_KEY, display);
};
setSensitivity(sensitivity);
const sensitivitySettings = document.getElementById("sensitivity-settings") as HTMLDivElement;
sensitivitySettings.addEventListener("click", (e) => e.stopPropagation());
for (const input of [sensitivityRange, sensitivityValue]) {
  input.addEventListener("input", () => setSensitivity(Number(input.value)));
}

const fullscreenToggle = document.getElementById("fullscreen-toggle") as HTMLInputElement;
fullscreenToggle.checked = document.fullscreenElement !== null;
fullscreenToggle.addEventListener("change", () => {
  if (fullscreenToggle.checked) void document.documentElement.requestFullscreen();
  else if (document.fullscreenElement) void document.exitFullscreen();
});
document.addEventListener("fullscreenchange", () => {
  fullscreenToggle.checked = document.fullscreenElement !== null;
});
const clampPitch = (p: number) => Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, p));
let adsT = 0; // 0 = hip, 1 = fully aimed (smoothed per frame)
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  const sens = MOUSE_SENS * sensitivity * (1 + ((currentDef()?.adsSensitivity ?? 1) - 1) * adsT);
  look.yaw -= e.movementX * sens;
  look.pitch = clampPitch(look.pitch - e.movementY * sens);
});
document.addEventListener("mousedown", (e) => {
  if (document.pointerLockElement !== canvas) return;
  held.add(`Mouse${e.button}`);
  // With empty hands there is no gun to fire: the left button punches.
  if (e.button === 0 && currentWeapon().slot === EMPTY_HANDS) pressed.melee = true;
});
document.addEventListener("mouseup", (e) => held.delete(`Mouse${e.button}`));
document.addEventListener("contextmenu", (e) => e.preventDefault());
// The hero picker on the pause screen (the overlay shown while the mouse is released).
const heroesEl = document.getElementById("heroes") as HTMLDivElement;
const HERO_KEY = "arena.hero";
/** The hero chosen last time (kept in the browser), sent to the server when we join. */
const savedHero = (): number => {
  const n = Number(localStorage.getItem(HERO_KEY));
  return Number.isInteger(n) && n >= 0 && n < HERO_NAMES.length ? n : HeroKinds.trooper;
};
/** Draw the picker: who you are now, and who you will be next life if you have changed. */
function showHeroes(hero: number, next: number): void {
  const html =
    `<span class="label">Hero</span>` +
    HERO_NAMES.map(
      (name, i) => `<button data-hero="${i}"${i === next ? ' class="on"' : ""}>${name}</button>`,
    ).join("") +
    `<small>${next === hero ? "" : `You become the ${HERO_NAMES[next] ?? "?"} on your next life.`}</small>`;
  if (heroesEl.innerHTML !== html) heroesEl.innerHTML = html;
}
heroesEl.addEventListener("click", (e) => {
  e.stopPropagation(); // a click here chooses a hero: it must not also resume the game
  const hero = Number((e.target as HTMLElement).dataset.hero);
  if (!Number.isInteger(hero)) return;
  localStorage.setItem(HERO_KEY, String(hero));
  net?.sendHero(hero);
});
showHeroes(HeroKinds.trooper, savedHero());
const lockPointer = () => void canvas.requestPointerLock();
hint.addEventListener("click", lockPointer);
canvas.addEventListener("click", lockPointer);
document.addEventListener("pointerlockchange", () => {
  const locked = document.pointerLockElement === canvas;
  hint.classList.toggle("hidden", locked);
  if (!locked) held.clear();
});

const axis = (pos: string, neg: string) => Number(held.has(pos)) - Number(held.has(neg));
const INPUT_SEND_EVERY = 2; // Send two simulated ticks per datagram; include four inputs for overlap.

// --- Networking ------------------------------------------------------------
// Online (default): the server owns the truth. We predict our own movement with the
// same stepPlayer, send numbered inputs, and reconcile against snapshots. Other
// players are drawn ~100 ms in the past, interpolated between snapshots.
// There is no offline mode: without a server there is no game ("down" below), only a message.
let net: NetClient | null = null;
let netMode: "connecting" | "online" | "down" = "connecting";
let netNote = "";
let predictor: Predictor | null = null;
const smoother = new CorrectionSmoother();
const clock = new ServerClock();
const remotes = new RemoteTracks();
const remoteViews = new RemoteViews(scene, () => world);
// (A stuck spear's danger zone is drawn on the floor under it: a ray straight down finds it.)
const skillViews = new SkillViews(scene, (x, y, z) => {
  const hit = castRay(world, [], [x, y + 0.2, z], [0, -1, 0], 60);
  return hit.kind === "world" ? y + 0.2 - hit.t : y;
});
/** Bombardments already on screen (a new one sounds its warning once). */
const knownStrikes = new Set<number>();
let shellSoundIn = 0;
let hooksWere = 0;
/** After a melee hit lands on you, corrections blend more gently for a moment (the shove arrives). */
const KNOCK_WINDOW_MS = 500;
const KNOCK_SNAP_DISTANCE = 6;
const KNOCK_SMOOTH_TIME = 0.16;
let knockUntil = 0;
const events = new EventTracker();
const shotFeed = new ShotTracker();
/** Other players' shots waiting for the screen to reach the moment they were fired. */
const pendingShots: Shot[] = [];
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

/** Practice tools and the stats panel are on in the practice range. */
const inRange = () => netMode === "online" && gameMode === "practice";

/** K: reset the targets and the stats. */
function practiceReset(): void {
  if (!inRange()) return;
  practiceStats.reset();
  net?.sendPractice("reset");
}

/** H: refill health and ammo. */
function practiceRefill(): void {
  if (!inRange()) return;
  net?.sendPractice("refill");
}

/** T: back to the start of the movement course. */
function practiceStart(): void {
  if (!inRange()) return;
  net?.sendPractice("start");
}

function practiceHtml(): string {
  const s = practiceStats;
  const secs = (v: number | null) => (v === null ? "–" : `${v.toFixed(2)}s`);
  return (
    `<b>PRACTICE RANGE</b><br>` +
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
  if ((e.flags & GameEventFlags.melee) !== 0)
    audio.meleeHit((e.flags & GameEventFlags.killed) !== 0);
  else
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
  const pose = clock.ready
    ? remotes.sample(
        id,
        clock.tickAt(performance.now()) - interpolationTicks(net?.stats.jitterMs ?? 0),
      )
    : null;
  if (!pose) return null;
  const height = pose.flags & EntityFlags.crouching ? PARAMS.crouchHeight : PARAMS.standHeight;
  return view.toScreen(pose.x, pose.y + height + HEAD_GAP, pose.z);
}

/** The server cannot be reached, or the connection dropped: stop, and say so. There is no offline play. */
const NO_SERVER = "Cannot reach the game server. Start it (pnpm dev) and try again.";
function serverDown(note: string): void {
  netMode = "down";
  netNote = note;
  if (!roomInfoEl.querySelector(".err"))
    roomInfoEl.innerHTML = `<span class="err">${note}</span> <a href="${location.href}">Try again</a>`;
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
      if (savedHero() !== HeroKinds.trooper) net?.sendHero(savedHero()); // who we were last time
      gameMode = w.mode === "practice" ? "practice" : "ffa";
      if (w.level !== level.name) {
        const next = levelByName(w.level);
        if (next) useLevel(next);
        else netNote = `WARNING: server runs "${w.level}", client has no such map`;
      }
    },
    onSnapshot(s) {
      clock.onSnapshot(s.tick, performance.now());
      remotes.push(s.tick, s.entities, s.removed, s.full);
      health = s.health;
      useSelfHero(s.health.hero);
      showHeroes(s.health.hero, s.health.nextHero);
      match = s.match;
      scores = s.scores;
      for (const sh of shotFeed.fresh(s.shots)) if (sh.actor !== myId) pendingShots.push(sh);
      for (const e of events.fresh(s.events)) {
        combatHud.onEvent(e);
        if (e.kind === EventKinds.hurt && e.other === myId) {
          audio.hurt(e.amount);
          if ((e.flags & GameEventFlags.melee) !== 0) {
            // Shoved: the next correction is the knockback arriving. Blend it gently (and let it
            // be big) instead of snapping, and kick the camera now.
            knockUntil = performance.now() + KNOCK_WINDOW_MS;
            smoother.snapDistance = KNOCK_SNAP_DISTANCE;
            smoother.smoothTime = KNOCK_SMOOTH_TIME;
            fx.bump(0.7);
          }
        }
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
        serverDown(why);
      } else {
        serverDown(wasConnected ? "Connection to the server lost." : NO_SERVER);
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
    serverDown(NO_SERVER);
    menuNote.textContent = "";
  }
}

document.getElementById("play-ffa")?.addEventListener("click", () => void startRoom("ffa"));
document
  .getElementById("play-practice")
  ?.addEventListener("click", () => void startRoom("practice"));

{
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
/** Shown until the server has sent our real weapon. */
const weapon = spawnWeapon(1);

/** Other players as the local screen currently draws them (effects only: the server decides hits). */
function remoteHitboxes(renderTick: number): Hitbox[] {
  const boxes: Hitbox[] = [];
  for (const id of remotes.ids()) {
    const pose = remotes.sample(id, renderTick);
    if (!pose || (pose.flags & EntityFlags.dead) !== 0) continue;
    if (pose.kind === EntityKinds.barrier) {
      // A barrier stops your bullets too: its box, with no head zone (yaw 0 spans X).
      const alongX = Math.abs(Math.sin(pose.yaw)) < 0.5;
      const hx = (alongX ? SKILL.barrierWidth : SKILL.barrierThickness) / 2;
      const hz = (alongX ? SKILL.barrierThickness : SKILL.barrierWidth) / 2;
      const top = pose.y + SKILL.barrierHeight;
      boxes.push({
        id,
        headMinY: top + 1,
        minX: pose.x - hx,
        maxX: pose.x + hx,
        minY: pose.y,
        maxY: top,
        minZ: pose.z - hz,
        maxZ: pose.z + hz,
      });
      continue;
    }
    if (isSkillPose(pose)) continue; // grenades and bombardments are not things you can shoot
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
  fx.shot(ads);
  // The picture of the shot (the server decides hits): a bullet to fly, at its gun's speed.
  // A thunder spear is its own object, sent by the server.
  const def = currentDef();
  if (def && !def.spear) fx.fireOwn(origin, dir, def);
  look.yaw += shot.kickYaw;
  look.pitch = clampPitch(look.pitch + shot.kickPitch);
}

const sim = new FixedTimestep(() => {
  simTicks++;
  const ads = held.has("Mouse2") && currentWeapon().slot !== EMPTY_HANDS;
  const input = {
    ...emptyInput(),
    moveX: axis("KeyD", "KeyA"),
    moveZ: axis("KeyW", "KeyS"),
    yaw: look.yaw,
    jump: pressed.jump,
    dash: pressed.dash,
    slide: held.has("KeyC"),
    ads,
    fire: held.has("Mouse0"),
    reload: pressed.reload,
    melee: pressed.melee,
    slot: pressed.slot,
    skillQ: pressed.skillQ,
    reel: held.has("KeyQ"), // the Assassin's grapple reels in while Q stays down
    skillE: pressed.skillE,
    ult: pressed.ult,
    // What we believe we are, so the prediction matches; the server uses its own truth.
    hero: selfHero,
    overdrive: (health?.overdrive ?? 0) > 0,
  };
  prevPlayer = player;
  if (predictor) {
    // Online: predict now (movement and weapon), tell the server (the last few inputs, so a lost
    // message loses nothing). viewTick says which moment of the world our screen is showing.
    const interpTicks = interpolationTicks(net?.stats.jitterMs ?? 0);
    const viewTick = clock.ready ? clock.tickAt(performance.now()) - interpTicks : 0;
    predictor.step(input, look.pitch, viewTick);
    player = predictor.state;
    if (simTicks % INPUT_SEND_EVERY === 0) net?.sendInputs(predictor.recent(4));
    if (predictor.lastShot) shotSounds(predictor.lastShot);
    if (predictor.lastShot?.fired) {
      practiceStats.onShot();
      fireShotOnline(predictor.lastShot, ads);
    }
  } // else: still connecting (or no server): nothing to simulate

  pressed.jump = false;
  pressed.dash = false;
  pressed.reload = false;
  pressed.melee = false;
  pressed.slot = 0;
  pressed.skillQ = false;
  pressed.skillE = false;
  pressed.ult = false;
});

function netHud(): string {
  if (netMode !== "online" || !net || !predictor) {
    return `net: ${netMode} ${netNote}`;
  }
  const st = net.stats;
  return (
    `net: online #${net.playerId} | ping ${st.rttMs.toFixed(0)} ms ±${st.jitterMs.toFixed(0)} | ` +
    `${st.snapshotsPerSecond} snap/s ${st.snapshotBytes} B | server queue ${st.queued} | unacked ${predictor.pending}\n` +
    `prediction: ${predictor.corrections} corrections, worst ${(predictor.maxError * 100).toFixed(1)} cm | ` +
    `room ${roomCode} | ${remotes.ids().length} remote | interp ${(interpolationTicks(st.jitterMs) * 1000) / TICK_RATE} ms ${netNote}`
  );
}

// --- Render ----------------------------------------------------------------
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
let eye = PARAMS.standEye;
let lastFrame = 0;
/** Frames per second, averaged over half a second so the number is readable. */
let fps = 0;
let fpsFrames = 0;
let fpsSince = 0;

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
  fpsFrames++;
  if (nowMs - fpsSince >= 500) {
    fps = (fpsFrames * 1000) / (nowMs - fpsSince);
    fpsFrames = 0;
    fpsSince = nowMs;
  }
  const alpha = sim.advance(nowMs);
  const cam = view.camera;

  // Aim down sights: smooth zoom.
  const adsHeld = held.has("Mouse2") && currentWeapon().slot !== EMPTY_HANDS;
  adsT += ((adsHeld ? 1 : 0) - adsT) * (1 - Math.exp(-frameDt * 14));
  const fov = hipFov * (1 + ((currentDef()?.adsFovScale ?? 1) - 1) * adsT);
  if (Math.abs(cam.fov - fov) > 0.01) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }

  // Smooth the eye height so slide transitions don't pop.
  const dead = health !== null && !health.alive;
  eye += ((dead ? 0.35 : eyeHeight(player)) - eye) * (1 - Math.exp(-frameDt * 18));
  if (knockUntil !== 0 && nowMs > knockUntil) {
    knockUntil = 0;
    smoother.snapDistance = SNAP_DISTANCE;
    smoother.smoothTime = SMOOTH_TIME;
  }
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
  selfState.armed = currentWeapon().slot !== EMPTY_HANDS;
  selfState.weapon = currentWeapon().gun;
  selfState.yaw = look.yaw + Math.PI; // the figure faces +Z, the camera looks down -Z at yaw 0
  selfBody.update(selfState, frameDt, cam.position);
  // Only show your body when you look down at it (or when dead): sliding, crouching, dashing
  // and wall running pose it in ways that would otherwise put legs and torso in the way of the
  // view while you look ahead. A little hysteresis stops it flickering at the edge.
  selfBodyShown = look.pitch < (selfBodyShown ? SELF_BODY_SHOW_PITCH + 0.05 : SELF_BODY_SHOW_PITCH);
  // Not while dashing, sliding or mantling either: those poses throw the torso about.
  const posed = player.dashTime > 0 || player.sliding || player.mantling;
  selfBody.root.visible = (selfBodyShown && !posed) || dead;

  // Other players: where they were a jitter-adjusted buffer ago, interpolated between snapshots.
  const renderTick = clock.tickAt(nowMs) - interpolationTicks(net?.stats.jitterMs ?? 0);
  const poses = clock.ready
    ? remotes.ids().flatMap((id) => {
        const pose = remotes.sample(id, renderTick);
        return pose ? [pose] : [];
      })
    : [];
  remoteViews.update(
    poses.filter((p) => !isSkillPose(p)),
    frameDt,
    cam.position,
  );
  // Grenades, barriers and bombardments, and the sounds they make.
  const skillPoses = poses.filter(isSkillPose);
  for (const p of skillPoses) {
    // A new bombardment: its siren, if it gives any warning before the shells.
    if (p.kind === EntityKinds.strike && !knownStrikes.has(p.id) && SKILL.bombardWarning > 0)
      audio.strikeWarning(p);
  }
  knownStrikes.clear();
  for (const p of skillPoses) if (p.kind === EntityKinds.strike) knownStrikes.add(p.id);
  // Grapple lines: ours from the predicted state (no delay), everyone else's from their hook.
  const lines: GrappleLine[] = [];
  if (player.grappling && !dead) {
    // One line from each hand, so two hooks read as a V.
    const side = player.grapple2 ? 0.25 : 0;
    const rx = Math.cos(look.yaw) * side;
    const rz = -Math.sin(look.yaw) * side;
    const hand = cam.position.y - 0.35;
    lines.push({
      from: [cam.position.x - rx, hand, cam.position.z - rz],
      to: [player.grappleX, player.grappleY, player.grappleZ],
    });
    if (player.grapple2)
      lines.push({
        from: [cam.position.x + rx, hand, cam.position.z + rz],
        to: [player.grapple2X, player.grapple2Y, player.grapple2Z],
      });
  }
  for (const hook of skillPoses) {
    if (hook.kind !== EntityKinds.hook || hook.teamId === myId) continue;
    const owner = poses.find((p) => p.id === hook.teamId);
    if (owner)
      lines.push({ from: [owner.x, owner.y + 1.2, owner.z], to: [hook.x, hook.y, hook.z] });
  }
  // A sound for each hook that goes out (the first, and the second of a V).
  const hooksOut = player.grappling ? (player.grapple2 ? 2 : 1) : 0;
  if (hooksOut > hooksWere) audio.grapple();
  hooksWere = hooksOut;
  const skillSounds = skillViews.update(
    skillPoses.filter((p) => p.kind !== EntityKinds.hook),
    frameDt,
    lines,
  );
  for (const at of skillSounds.blasts) audio.explosion(at);
  for (const at of skillSounds.taken) audio.recharge(at);
  shellSoundIn -= frameDt;
  if (skillSounds.shelling.length > 0 && shellSoundIn <= 0) {
    shellSoundIn = SKILL.bombardInterval;
    for (const at of skillSounds.shelling) audio.explosion(at, 0.5);
  }
  // Other players' bullets start when the screen reaches the moment they were fired, and every
  // bullet on screen flies on (it ends at a wall or at a person, like the real one).
  while (clock.ready && pendingShots[0] && pendingShots[0].tick <= renderTick) {
    const sh = pendingShots.shift() as Shot;
    const sniper = sh.gun === 1;
    fx.fireRemote([sh.x, sh.y, sh.z], [sh.dx, sh.dy, sh.dz], WEAPON_DEFS[sniper ? 1 : 0]);
    audio.shotAt({ x: sh.x, y: sh.y, z: sh.z }, sniper);
  }
  if (pendingShots.length > 64) pendingShots.splice(0, pendingShots.length - 64);
  fx.stepBullets(
    frameDt,
    world,
    netMode === "online" && clock.ready ? remoteHitboxes(renderTick) : [],
  );
  updateSound(frameDt, renderTick, cam);
  const activeWeapon = predictor ? predictor.weapon : weapon;
  const def = activeDef(activeWeapon);
  // Keep the viewmodel showing the gun in hand (it also changes without a switch: respawn).
  const heldNow = activeWeapon.slot !== EMPTY_HANDS;
  if (syncedGun !== activeWeapon.gun * 10 + (heldNow ? 1 : 0)) {
    fx.setWeapon(activeWeapon.gun, heldNow);
    syncedGun = activeWeapon.gun * 10 + (heldNow ? 1 : 0);
  }
  const spread = spreadDegrees(
    activeWeapon.burst,
    adsHeld,
    {
      hSpeed: hSpeed(player),
      onGround: player.onGround,
      crouching: player.crouching,
      sliding: player.sliding,
    },
    def ?? WEAPON_DEFS[0],
  );
  fx.setDiving(player.rollT > 0, player.rollT > 0 ? diveLeft() : undefined);
  const shake = fx.update(
    frameDt,
    adsT,
    spread,
    fov,
    activeWeapon.reloadT,
    def ? activeWeapon.ammo / def.magSize : 1,
    reloadTotal > 0 && activeWeapon.reloadT <= reloadTotal ? reloadTotal : def?.reloadTime,
  );
  // Wall run: bank the camera away from the wall (positive roll tilts the head left).
  const wallOnRight =
    -player.wallNormalX * Math.cos(look.yaw) + player.wallNormalZ * Math.sin(look.yaw);
  const rollTarget =
    player.wallRunning && health?.alive !== false ? Math.sign(wallOnRight) * WALL_ROLL : 0;
  camRoll += (rollTarget - camRoll) * (1 - Math.exp(-frameDt * 10));
  cam.rotation.set(look.pitch + shake.pitch, look.yaw + shake.yaw, camRoll);
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
  ammoEl.innerHTML = def
    ? `${activeWeapon.ammo} / ${def.magSize}<small>${
        activeWeapon.switchT > 0
          ? "DRAWING"
          : activeWeapon.reloadT > 0
            ? `RELOADING ${activeWeapon.reloadT.toFixed(1)}s`
            : activeWeapon.ammo === 0
              ? "RELOAD (R)"
              : ""
      }</small>`
    : "<small>EMPTY HANDS</small>";
  // The hero's own three: two guns (indices into WEAPON_DEFS) and what the hands are.
  const guns = LOADOUTS[selfHero] ?? [0, 1];
  const slotsHtml = [
    `1 ${WEAPON_DEFS[guns[0]]?.name ?? "?"}`,
    `2 ${WEAPON_DEFS[guns[1]]?.name ?? "?"}`,
    selfHero === HeroKinds.assassin ? "3 Blades" : "3 Fists",
  ]
    .map((name, i) => {
      const on = (i === 2 ? !heldNow : heldNow && activeWeapon.gun === guns[i])
        ? ' class="on"'
        : "";
      return `<span${on}>${name}</span>`;
    })
    .join("");
  if (slotsEl.innerHTML !== slotsHtml) slotsEl.innerHTML = slotsHtml;
  // Skills: ready (lit), or the seconds left; the ultimate shows its charge.
  const skill = (key: string, name: string, left: number) =>
    `<span${left <= 0 ? ' class="on"' : ""}>${key} ${name}${left > 0 ? ` ${Math.ceil(left)}s` : ""}</span>`;
  const ult = health?.ult ?? 0;
  const ultimate = (name: string) =>
    `<span${ult >= 1 ? ' class="on ult"' : ""}>F ${name}${ult >= 1 ? "" : ` ${Math.floor(ult * 100)}%`}</span>`;
  const overdrive = health?.overdrive ?? 0;
  const hooks = Math.floor(player.grappleCharges + 1e-6);
  const dashes = Math.floor(player.dashCharges + 1e-6);
  const skillsHtml =
    selfHero === HeroKinds.trooper
      ? `<span${dashes > 0 ? ' class="on"' : ""}>Shift Dash ${"●".repeat(dashes)}${"○".repeat(PARAMS.dashCharges - dashes)}</span>` +
        skill("Q", "Grenade", activeWeapon.skillQT) +
        skill("E", "Barrier", activeWeapon.skillET) +
        ultimate("Bombardment")
      : // The Assassin: grapple charges as dots, the dash cut (its dash button), the
        // rolling dive (in the air only), and overdrive.
        `<span${hooks > 0 ? ' class="on"' : ""}>Q Grapple ${"●".repeat(hooks)}${"○".repeat(SKILL.grappleCharges - hooks)}</span>` +
        skill("Shift", "Slash", activeWeapon.skillQT) +
        skill("E", "Dive", activeWeapon.skillET) +
        (overdrive > 0
          ? `<span class="on ult">OVERDRIVE ${overdrive.toFixed(1)}s</span>`
          : ultimate("Overdrive"));
  if (skillsEl.innerHTML !== skillsHtml) skillsEl.innerHTML = skillsHtml;
  view.render();

  const state = [
    dead ? "DEAD" : "",
    player.onGround ? "ground" : "air",
    player.sliding ? "slide" : "",
    player.crouching ? "crouch" : "",
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
    `WASD move · Space jump (beside a wall at speed you run along it, jump again to kick off) · Q, E, F skills (Trooper: grenade, barrier, bombardment · Assassin: grapple (hold Q to reel in, let go to swing, Space or C to drop), dive in the air, overdrive (10 s: blade skills back to back, grapples always ready, spears reload twice as fast, no sniper); its Shift is a dash cut (a dash ahead with both blades crossing), and it has no other dash or double jump) · V melee (or left click with empty hands) · 1 2 3 weapons · Shift dash · C crouch/slide · LMB fire · RMB aim · R reload · Tab scoreboard · Enter rematch · L copy link · P respawn (dev)\n` +
    `${fps.toFixed(0)} fps (${fps > 0 ? (1000 / fps).toFixed(1) : "-"} ms) | render ${RENDER_WIDTH}x${RENDER_HEIGHT} (?res=240..720) | sim ticks ${simTicks}\n` +
    netHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
