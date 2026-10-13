/**
 * Designated movement file (client side).
 *
 * The player movement function lives ONLY here (with collision.ts, params.ts,
 * types.ts) and in server/internal/game/movement*.go. Both must agree on every
 * vector in /testvectors. Any change here must update testvectors/ and the Go
 * twin in the same commit.
 *
 * stepPlayer is deterministic and has no hidden state: the result depends only
 * on (state, input, world, dt). No engine physics.
 */
import { blocked, overlaps, playerBox, rampSurface, supportHeight } from "./collision";
import { castRay } from "./hitscan";
import { PARAMS as P, SKILL } from "./params";
import type { Aabb, CollisionWorld, PlayerInput, PlayerState } from "./types";

export function spawnState(x: number, y: number, z: number): PlayerState {
  return {
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    onGround: false,
    crouching: false,
    sliding: false,
    slideTime: 0,
    slideCooldown: 0,
    dashCharges: P.dashCharges,
    dashTime: 0,
    dashDirX: 0,
    dashDirZ: 0,
    airJumps: P.maxAirJumps,
    coyote: 0,
    jumpBuffer: 0,
    mantling: false,
    mantleT: 0,
    mantleFromX: 0,
    mantleFromY: 0,
    mantleFromZ: 0,
    mantleToX: 0,
    mantleToY: 0,
    mantleToZ: 0,
    wallRunning: false,
    wallRunTime: 0,
    wallNormalX: 0,
    wallNormalZ: 0,
    wallJumps: 0,
    wallCooldown: 0,
    rollT: 0,
    rollDirX: 0,
    rollDirY: 0,
    rollDirZ: 0,
    grappling: false,
    grappleX: 0,
    grappleY: 0,
    grappleZ: 0,
    grapple2: false,
    grapple2X: 0,
    grapple2Y: 0,
    grapple2Z: 0,
    grappleLen: 0,
    grapple2Len: 0,
    grappleT: 0,
    grappleStall: 0,
    grappleCharges: SKILL.grappleCharges,
    slowT: 0,
  };
}

/** HeroKinds.assassin (protocol): the hero with the grapple. */
const HERO_ASSASSIN = 1;

export const hSpeed = (s: PlayerState): number => Math.hypot(s.vx, s.vz);
export const bodyHeight = (s: PlayerState): number =>
  s.sliding ? P.slideHeight : s.crouching ? P.crouchHeight : P.standHeight;
export const eyeHeight = (s: PlayerState): number =>
  s.sliding ? P.slideEye : s.crouching ? P.crouchEye : P.standEye;

interface WallHit {
  box: Aabb;
  axis: "x" | "z";
  /** Direction the player was moving along `axis` when blocked. */
  sign: 1 | -1;
}

interface Wish {
  /** Unit direction in world XZ (0,0 if no input). */
  x: number;
  z: number;
  /** Input magnitude, 0..1. */
  mag: number;
  /** Ground speed multiplier (1, less while aiming down sights, more with empty hands). */
  speed: number;
  /** The weapon's run speed multiplier alone (also applies in the air). */
  run: number;
}

function wishOf(input: PlayerInput): Wish {
  let mx = input.moveX;
  let mz = input.moveZ;
  const len = Math.hypot(mx, mz);
  if (len < 1e-9) return { x: 0, z: 0, mag: 0, speed: 1, run: 1 };
  const mag = Math.min(1, len);
  mx /= len;
  mz /= len;
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  // forward = (-sin, -cos), right = (cos, -sin)
  return {
    x: cos * mx - sin * mz,
    z: -sin * mx - cos * mz,
    mag,
    // 0 (a field an old input lacks) means the default.
    speed: (input.ads ? input.adsSpeedMult || P.adsSpeedMult : 1) * (input.runSpeedMult || 1),
    run: input.runSpeedMult || 1,
  };
}

/** Advance the player by dt seconds. Does not modify `prev`. */
export function stepPlayer(
  prev: PlayerState,
  input: PlayerInput,
  world: CollisionWorld,
  dt: number,
): PlayerState {
  const s: PlayerState = { ...prev };

  // Timers
  s.slideCooldown = Math.max(0, s.slideCooldown - dt);
  s.wallCooldown = Math.max(0, s.wallCooldown - dt);
  s.coyote = s.onGround ? P.coyoteTime : Math.max(0, s.coyote - dt);
  s.jumpBuffer = input.jump ? P.jumpBufferTime : Math.max(0, s.jumpBuffer - dt);
  // Slowed by a bullet hit (the server sets slowT): running is slower until it runs out.
  const slow = s.slowT > 0 ? P.hitSlowMult : 1;
  s.slowT = Math.max(0, s.slowT - dt);

  if (s.mantling) {
    stepMantle(s, dt);
    return s;
  }

  const wish = wishOf(input);
  const wasGround = s.onGround;
  const wasDashing = s.dashTime > 0;

  if (!wasDashing) {
    s.dashCharges = Math.min(P.dashCharges, s.dashCharges + dt / P.dashRegenTime);
  }
  // (The Assassin has no dash: that button is the spinning slash, see weapon.ts.)
  if (input.dash && s.dashCharges >= 1 && !wasDashing && input.hero !== HERO_ASSASSIN) {
    s.dashCharges -= 1;
    s.dashTime = P.dashDuration;
    if (wish.mag > 0) {
      s.dashDirX = wish.x;
      s.dashDirZ = wish.z;
    } else {
      s.dashDirX = -Math.sin(input.yaw);
      s.dashDirZ = -Math.cos(input.yaw);
    }
  }

  updateGrapple(s, input, world, dt);
  const wasRolling = s.rollT > 0;

  if (s.dashTime > 0) {
    // Dash overrides everything: constant velocity, no gravity.
    endWallRun(s);
    if (input.hero !== HERO_ASSASSIN) {
      // (The Assassin's dash is its slash, which stays on the line.)
      s.grappling = false;
      s.grapple2 = false;
    }
    s.vx = s.dashDirX * P.dashSpeed;
    s.vz = s.dashDirZ * P.dashSpeed;
    s.vy = 0;
    s.dashTime = Math.max(0, s.dashTime - dt);
  } else if (s.rollT > 0) {
    // The rolling dive: straight along where it was aimed (forward and down) at a fixed speed,
    // until it hits something or its time runs out. No gravity, no steering.
    endWallRun(s);
    s.sliding = false;
    s.crouching = false;
    s.vx = s.rollDirX * SKILL.rollSpeed;
    s.vy = s.rollDirY * SKILL.rollSpeed;
    s.vz = s.rollDirZ * SKILL.rollSpeed;
    s.rollT = Math.max(0, s.rollT - dt);
    s.jumpBuffer = 0;
  } else if (s.grappling && (!s.onGround || input.reel)) {
    // Grapple: on a line. Gravity acts and you can steer, and the line holds you (holdLine), so
    // you swing. While the button is held the line also reels you in: a pull toward the hook,
    // or up the middle of two. (Standing on the ground without reeling, you keep the line but
    // move as usual: see below.)
    endWallRun(s);
    s.sliding = false;
    s.crouching = false;
    if (wish.mag > 0) accelerate(s, wish, P.runSpeed * wish.mag, SKILL.grappleSteer, dt);
    s.vy -= P.gravity * (input.reel ? SKILL.grappleGravityScale : 1) * dt;
    if (input.reel) {
      const [dx, dy, dz] = pullDirection(s);
      s.vx += dx * SKILL.grapplePull * dt;
      s.vy += dy * SKILL.grapplePull * dt;
      s.vz += dz * SKILL.grapplePull * dt;
    }
    holdLine(s, s.grappleX, s.grappleY, s.grappleZ, s.grappleLen, dt);
    if (s.grapple2) holdLine(s, s.grapple2X, s.grapple2Y, s.grapple2Z, s.grapple2Len, dt);
    const speed = Math.hypot(s.vx, s.vy, s.vz);
    if (speed > SKILL.grappleSpeed) {
      const k = SKILL.grappleSpeed / speed;
      s.vx *= k;
      s.vy *= k;
      s.vz *= k;
    }
    s.grappleT += dt;
    s.jumpBuffer = 0;
  } else {
    updateWallRun(s, input, wish, world);
    if (s.wallRunning) {
      if (input.jump) wallJump(s);
      else runAlongWall(s, dt);
    } else {
      updateSlide(s, input, world, dt);
      updateCrouch(s, input, world);
      updateHorizontalVelocity(s, wish, slow, dt);
      if (!tryWallJump(s, input, world)) tryJump(s, input, world);
      if (!s.onGround) s.vy = Math.max(-P.terminalVelocity, s.vy - P.gravity * dt);
      else if (s.vy < 0) s.vy = 0;
    }
    if (s.grappling) {
      // On the ground with a line out and the button up: the line is kept (it only lets go on a
      // jump or a crouch), and still will not let you get further from the hook than it is long.
      holdLine(s, s.grappleX, s.grappleY, s.grappleZ, s.grappleLen, dt);
      if (s.grapple2) holdLine(s, s.grapple2X, s.grapple2Y, s.grapple2Z, s.grapple2Len, dt);
    }
  }

  const hit = integrate(s, world, dt);
  if (s.grappling) {
    const d1 = toHook(s, s.grappleX, s.grappleY, s.grappleZ)[3];
    const d2 = s.grapple2 ? toHook(s, s.grapple2X, s.grapple2Y, s.grapple2Z)[3] : 0;
    if (input.reel) {
      // Reeling takes the line in as you come closer. Getting no closer for a while means you
      // are circling the hook (or something is in the way): it lets go.
      const closer = d1 < s.grappleLen - 0.02 || (s.grapple2 && d2 < s.grapple2Len - 0.02);
      s.grappleStall = closer ? 0 : s.grappleStall + dt;
      s.grappleLen = Math.min(s.grappleLen, d1);
      if (s.grapple2) s.grapple2Len = Math.min(s.grapple2Len, d2);
    } else {
      s.grappleStall = 0;
    }
    // Let go: on reaching a hook; reeling, once between two hooks (the lines pull against each
    // other) or stalled; on crouch; or when it has gone on too long. The speed is kept: the fling.
    // (Letting go of the button does not let go of the line, in the air or on the ground: a jump
    // does, see updateGrapple.)
    const reeledOut =
      input.reel &&
      (pullDirection(s)[3] < SKILL.grappleSplit || s.grappleStall >= SKILL.grappleStallTime);
    if (
      nearestHook(s) <= SKILL.grappleArrive ||
      reeledOut ||
      input.slide ||
      s.grappleT >= SKILL.grappleMaxTime
    )
      endGrapple(s, false);
  }

  if (wasDashing && s.dashTime <= 0) {
    // Dash just ended: keep some momentum.
    s.vx = s.dashDirX * P.dashExitSpeed;
    s.vz = s.dashDirZ * P.dashExitSpeed;
  }

  probeGround(s, world, wasGround);

  if (wasRolling) {
    // The dive ends when its time is up, or early on hitting the ground (the slam) or a wall;
    // part of the speed is kept.
    if (hit || s.onGround) s.rollT = 0;
    if (s.rollT <= 0) {
      s.vx *= SKILL.rollExitScale;
      s.vy *= SKILL.rollExitScale;
      s.vz *= SKILL.rollExitScale;
    }
  } else if (hit && !s.onGround) tryStartMantle(s, world, wish, hit);

  return s;
}

// --- Slide -----------------------------------------------------------------

function fitsStanding(s: PlayerState, world: CollisionWorld): boolean {
  return !blocked(world, playerBox(s.x, s.y, s.z, P.standHeight));
}

function endSlide(s: PlayerState): void {
  s.sliding = false;
  s.slideCooldown = P.slideCooldown;
}

function updateSlide(s: PlayerState, input: PlayerInput, world: CollisionWorld, dt: number): void {
  const speed = hSpeed(s);
  if (!s.sliding) {
    if (input.slide && s.onGround && !s.crouching && speed >= P.slideMinSpeed) {
      s.sliding = true;
      s.slideTime = 0;
      if (s.slideCooldown <= 0 && speed < P.slideSpeed) {
        const k = P.slideSpeed / speed;
        s.vx *= k;
        s.vz *= k;
      }
    }
    return;
  }
  s.slideTime += dt;
  const wantEnd =
    !input.slide || !s.onGround || speed < P.slideEndSpeed || s.slideTime > P.slideMaxTime;
  // Cannot stand up under a low ceiling: stay in the slide.
  if (wantEnd && fitsStanding(s, world)) endSlide(s);
}

/**
 * Crouch: hold the slide key while on the ground without being fast enough to
 * slide. A finished slide with the key still held settles into a crouch.
 */
function updateCrouch(s: PlayerState, input: PlayerInput, world: CollisionWorld): void {
  if (s.sliding) {
    s.crouching = false;
    return;
  }
  if (!s.crouching) {
    if (input.slide && s.onGround) s.crouching = true;
    return;
  }
  // Stay low while the key is held or while there is no room to stand.
  if (!input.slide && fitsStanding(s, world)) s.crouching = false;
}

// --- Horizontal velocity ---------------------------------------------------

function accelerate(
  s: PlayerState,
  wish: Wish,
  wishSpeed: number,
  accel: number,
  dt: number,
): void {
  const add = wishSpeed - (s.vx * wish.x + s.vz * wish.z);
  if (add <= 0) return;
  const a = Math.min(accel * wishSpeed * dt, add);
  s.vx += a * wish.x;
  s.vz += a * wish.z;
}

/** Reduce horizontal speed by `drop`, never below `floor`. */
function reduceSpeed(s: PlayerState, drop: number, floor: number): void {
  const speed = hSpeed(s);
  if (speed < 1e-9) return;
  const next = Math.max(floor, speed - drop);
  if (next >= speed) return;
  const k = next / speed;
  s.vx *= k;
  s.vz *= k;
}

function updateHorizontalVelocity(s: PlayerState, wish: Wish, slow: number, dt: number): void {
  if (s.sliding && s.onGround && hSpeed(s) >= P.slideEndSpeed) {
    // Momentum slide: fixed direction, linear decay.
    reduceSpeed(s, P.slideDecel * dt, 0);
    return;
  }
  if (s.onGround) {
    // Crouch-walk (also when stuck low under a ceiling after a slide).
    const wishSpeed =
      (s.sliding || s.crouching ? P.crouchSpeed : P.runSpeed) * wish.mag * wish.speed * slow;
    if (wish.mag === 0) {
      reduceSpeed(s, Math.max(hSpeed(s), P.stopSpeed) * P.groundFriction * dt, 0);
    } else {
      // Only bleed off overspeed (e.g. after a slide or dash); never slow below run speed.
      const speed = hSpeed(s);
      if (speed > wishSpeed) {
        reduceSpeed(s, speed * P.groundFriction * dt, wishSpeed);
      }
      accelerate(s, wish, wishSpeed, P.groundAccel, dt);
    }
    return;
  }
  // Air: steer freely but never gain speed beyond what we had (or run speed).
  const before = hSpeed(s);
  if (wish.mag > 0) accelerate(s, wish, P.runSpeed * wish.run * wish.mag * slow, P.airAccel, dt);
  const cap = Math.max(before, P.runSpeed * wish.run);
  const after = hSpeed(s);
  if (after > cap) {
    s.vx *= cap / after;
    s.vz *= cap / after;
  }
}

// --- Jump ------------------------------------------------------------------

function tryJump(s: PlayerState, input: PlayerInput, world: CollisionWorld): void {
  const canGroundJump = s.onGround || s.coyote > 0;
  if (s.jumpBuffer > 0 && canGroundJump) {
    if (s.sliding) {
      if (!fitsStanding(s, world)) return;
      endSlide(s);
      // A jump out of a slide costs part of its speed (never below run speed), so chained
      // slide-jumps wind down.
      reduceSpeed(s, hSpeed(s) * (1 - P.slideJumpKeep), P.runSpeed);
    }
    if (s.crouching) {
      if (!fitsStanding(s, world)) return;
      s.crouching = false;
    }
    s.vy = P.jumpSpeed;
    s.onGround = false;
    s.coyote = 0;
    s.jumpBuffer = 0;
    return;
  }
  // Air jump: only on a fresh press (a buffered press must not burn it just before landing).
  // (The Assassin has no air jump: the grapple and the dive are its air movement.)
  if (input.jump && !canGroundJump && s.airJumps > 0 && input.hero !== HERO_ASSASSIN) {
    s.airJumps -= 1;
    s.vy = P.airJumpSpeed;
    s.jumpBuffer = 0;
  }
}

// --- Integration and collision --------------------------------------------

function integrate(s: PlayerState, world: CollisionWorld, dt: number): WallHit | null {
  const maxDisp = Math.max(Math.abs(s.vx), Math.abs(s.vy), Math.abs(s.vz)) * dt;
  const n = Math.max(1, Math.ceil(maxDisp / P.maxSubstep));
  const h = dt / n;
  let hit: WallHit | null = null;
  for (let i = 0; i < n; i++) {
    hit = moveHorizontal(s, world, "x", s.vx * h) ?? hit;
    hit = moveHorizontal(s, world, "z", s.vz * h) ?? hit;
    moveVertical(s, world, s.vy * h);
  }
  return hit;
}

/** Move along one horizontal axis, stepping up small ledges and pushing out of walls. */
function moveHorizontal(
  s: PlayerState,
  world: CollisionWorld,
  axis: "x" | "z",
  d: number,
): WallHit | null {
  if (d === 0) return null;
  const before = s[axis];
  s[axis] += d;
  const hw = P.halfWidth;
  let hit: WallHit | null = null;

  for (const b of world.boxes) {
    if (!overlaps(playerBox(s.x, s.y, s.z, bodyHeight(s)), b)) continue;
    // Small ledge: step up onto it instead of stopping.
    if (b.maxY > s.y && b.maxY - s.y <= P.stepHeight) {
      const oldY = s.y;
      s.y = b.maxY;
      if (!blocked(world, playerBox(s.x, s.y, s.z, bodyHeight(s)))) continue;
      s.y = oldY;
    }
    if (d > 0) s[axis] = (axis === "x" ? b.minX : b.minZ) - hw;
    else s[axis] = (axis === "x" ? b.maxX : b.maxZ) + hw;
    if (axis === "x") s.vx = 0;
    else s.vz = 0;
    hit = { box: b, axis, sign: d > 0 ? 1 : -1 };
  }

  for (const r of world.ramps) {
    const surf = rampSurface(r, playerBox(s.x, s.y, s.z, bodyHeight(s)));
    if (surf === null || s.y >= surf) continue;
    if (surf - s.y <= P.rampStep) {
      s.y = surf;
    } else {
      // The tall side of a ramp is a wall.
      s[axis] = before;
      if (axis === "x") s.vx = 0;
      else s.vz = 0;
    }
  }
  return hit;
}

function moveVertical(s: PlayerState, world: CollisionWorld, dy: number): void {
  if (dy === 0) return;
  const prevY = s.y;
  s.y += dy;
  const height = bodyHeight(s);

  for (const b of world.boxes) {
    if (!overlaps(playerBox(s.x, s.y, s.z, height), b)) continue;
    if (dy < 0 && prevY >= b.maxY - 1e-6) {
      s.y = b.maxY;
      s.vy = 0;
    } else if (dy > 0 && prevY + height <= b.minY + 1e-6) {
      s.y = b.minY - height;
      s.vy = 0;
    }
  }

  for (const r of world.ramps) {
    const surf = rampSurface(r, playerBox(s.x, s.y, s.z, height));
    if (surf !== null && s.y < surf) {
      s.y = surf;
      if (s.vy < 0) s.vy = 0;
    }
  }
}

/** Decide whether we are standing on something, snapping down small drops. */
function probeGround(s: PlayerState, world: CollisionWorld, wasGround: boolean): void {
  const support = supportHeight(world, s.x, s.z, s.y);
  const gap = s.y - support;
  if ((s.vy <= 0 && gap <= P.groundEps) || (wasGround && s.vy <= 0 && gap <= P.snapDown)) {
    s.onGround = true;
    s.airJumps = P.maxAirJumps;
    s.wallJumps = 0;
    endWallRun(s);
    s.y = support;
    s.vy = 0;
  } else {
    s.onGround = false;
  }
}

// --- Grapple (the Assassin's first skill) ------------------------------------

/** From the player's chest to a hook at (hx, hy, hz): the unit direction and the distance (never zero). */
function toHook(
  s: PlayerState,
  hx: number,
  hy: number,
  hz: number,
): [number, number, number, number] {
  const dx = hx - s.x;
  const dy = hy - (s.y + bodyHeight(s) / 2);
  const dz = hz - s.z;
  const dist = Math.max(1e-6, Math.hypot(dx, dy, dz));
  return [dx / dist, dy / dist, dz / dist, dist];
}

/**
 * The line to a hook at (hx, hy, hz) holds: once the player is as far from the hook as the line
 * is long, any speed away from the hook is taken out (what is left is the swing around it), and
 * a little pull is added if the line has been stretched.
 */
function holdLine(
  s: PlayerState,
  hx: number,
  hy: number,
  hz: number,
  len: number,
  dt: number,
): void {
  const [ux, uy, uz, dist] = toHook(s, hx, hy, hz);
  if (dist < len) return;
  const toward = s.vx * ux + s.vy * uy + s.vz * uz;
  if (toward < 0) {
    s.vx -= ux * toward;
    s.vy -= uy * toward;
    s.vz -= uz * toward;
  }
  const back = (dist - len) * SKILL.grappleStretch * dt;
  s.vx += ux * back;
  s.vy += uy * back;
  s.vz += uz * back;
}

/** How far the nearer hook is. */
function nearestHook(s: PlayerState): number {
  const a = toHook(s, s.grappleX, s.grappleY, s.grappleZ)[3];
  return s.grapple2 ? Math.min(a, toHook(s, s.grapple2X, s.grapple2Y, s.grapple2Z)[3]) : a;
}

/**
 * Which way the grapple pulls: straight at one hook, or with two, along the middle of the V they
 * make (the two unit directions added together). The fourth number is how hard the two lines
 * pull together, 0 to 1: it falls to nothing as the player comes between the hooks.
 */
function pullDirection(s: PlayerState): [number, number, number, number] {
  const a = toHook(s, s.grappleX, s.grappleY, s.grappleZ);
  if (!s.grapple2) return [a[0], a[1], a[2], 1];
  const b = toHook(s, s.grapple2X, s.grapple2Y, s.grapple2Z);
  const x = a[0] + b[0];
  const y = a[1] + b[1];
  const z = a[2] + b[2];
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) return [0, 0, 0, 0];
  return [x / len, y / len, z / len, len / 2];
}

/** Let go of the grapple, keeping the speed (scaled by grappleExitScale); a jump adds a hop. */
function endGrapple(s: PlayerState, hop: boolean): void {
  s.grappling = false;
  s.grapple2 = false;
  s.grappleT = 0;
  s.grappleStall = 0;
  s.vx *= SKILL.grappleExitScale;
  s.vy *= SKILL.grappleExitScale;
  s.vz *= SKILL.grappleExitScale;
  if (hop) s.vy = Math.max(s.vy, SKILL.grappleHop);
}

/**
 * Charges come back one at a time (at once during overdrive). A press hooks the first solid
 * surface in view within range: from then on you are on a line (see the grapple branch of
 * stepPlayer), free to swing, and reeled in while the button stays held. A press in the middle of a pull adds a
 * second hook without letting go of the first, so the pull goes between the two (a V); with two
 * out already, the older one is dropped for the new one. A jump lets go with a hop, crouch lets go without. Only the Assassin
 * (input.hero) has it.
 */
function updateGrapple(
  s: PlayerState,
  input: PlayerInput,
  world: CollisionWorld,
  dt: number,
): void {
  s.grappleCharges = input.overdrive
    ? SKILL.grappleCharges
    : Math.min(SKILL.grappleCharges, s.grappleCharges + dt / SKILL.grappleRegen);
  if (input.hero !== HERO_ASSASSIN) {
    s.grappling = false;
    s.grapple2 = false;
    return;
  }
  if (s.grappling && input.jump) endGrapple(s, true);
  if (!input.skillQ || s.grappleCharges < 1) return;
  const cp = Math.cos(input.pitch);
  const dir: [number, number, number] = [
    -Math.sin(input.yaw) * cp,
    Math.sin(input.pitch),
    -Math.cos(input.yaw) * cp,
  ];
  const hit = castRay(world, [], [s.x, s.y + eyeHeight(s), s.z], dir, SKILL.grappleRange);
  if (hit.kind !== "world") return; // nothing to hook: the charge is kept
  s.grappleCharges -= 1;
  s.grappleT = 0;
  s.grappleStall = 0;
  if (!s.grappling) {
    s.grappling = true;
    s.grapple2 = false;
    s.grappleX = hit.x;
    s.grappleY = hit.y;
    s.grappleZ = hit.z;
    s.grappleLen = toHook(s, hit.x, hit.y, hit.z)[3];
  } else {
    if (s.grapple2) {
      // Two hooks out already: the older one goes, the newer becomes the first. Pressing again
      // and again like this is how grapples are chained.
      s.grappleX = s.grapple2X;
      s.grappleY = s.grapple2Y;
      s.grappleZ = s.grapple2Z;
      s.grappleLen = s.grapple2Len;
    }
    s.grapple2 = true;
    s.grapple2X = hit.x;
    s.grapple2Y = hit.y;
    s.grapple2Z = hit.z;
    s.grapple2Len = toHook(s, hit.x, hit.y, hit.z)[3];
  }
  // The hook biting: a kick toward it, and the air jump back, so one grapple leads into the next.
  const [kx, ky, kz] = toHook(s, hit.x, hit.y, hit.z);
  s.vx += kx * SKILL.grappleKick;
  s.vy += ky * SKILL.grappleKick;
  s.vz += kz * SKILL.grappleKick;
  s.airJumps = P.maxAirJumps;
  s.dashTime = 0;
  s.onGround = false;
}

/**
 * The dash of the Assassin's spinning slash: a real dash straight ahead, the same speed and
 * length as the Trooper's (it starts on the next tick). Called by whoever steps the weapon, on
 * the tick the slash happens, on both sides. It does not let go of a grapple.
 */
export function slashLunge(s: PlayerState, yaw: number): void {
  s.dashTime = P.dashDuration;
  s.dashDirX = -Math.sin(yaw);
  s.dashDirZ = -Math.cos(yaw);
  s.rollT = 0;
}

/**
 * Start the Assassin's rolling dive: forward and down, a slam to the front. It follows the view
 * but always points down by at least rollMinDive, so it comes down ahead of you even when you
 * are looking level. Called like slashLunge, on the tick the weapon step says the dive began.
 * It lets go of a grapple: a dive is a commitment.
 */
export function startRoll(s: PlayerState, yaw: number, pitch: number): void {
  const down = Math.min(pitch, -SKILL.rollMinDive);
  const cp = Math.cos(down);
  s.rollT = SKILL.rollTime;
  s.rollDirX = -Math.sin(yaw) * cp;
  s.rollDirY = Math.sin(down);
  s.rollDirZ = -Math.cos(yaw) * cp;
  s.grappling = false;
  s.grapple2 = false;
  s.dashTime = 0;
}

// --- Wall run and wall jump -------------------------------------------------

interface WallContact {
  /** Unit XZ direction pointing out of the wall, toward the player. */
  nx: number;
  nz: number;
}

/** Directions from the player to a wall, checked in this order (ties go to the first). */
const WALL_DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * A wall beside (or in front of, or behind) the player that can be run on or jumped off: a
 * solid box face within `wallRunReach`, tall enough to matter, and not the wall we just left
 * (see wallCooldown). When several qualify, the one we are moving along fastest wins.
 */
function findWall(world: CollisionWorld, s: PlayerState): WallContact | null {
  const height = bodyHeight(s);
  let best: WallContact | null = null;
  let bestAlong = -1;
  for (const [dx, dz] of WALL_DIRS) {
    const nx = -dx;
    const nz = -dz;
    if (s.wallCooldown > 0 && nx * s.wallNormalX + nz * s.wallNormalZ > 0.9) continue;
    const probe = playerBox(s.x + dx * P.wallRunReach, s.y, s.z + dz * P.wallRunReach, height);
    let found = false;
    for (const b of world.boxes) {
      if (b.maxY > s.y + P.wallRunMinHeight && overlaps(probe, b)) {
        found = true;
        break;
      }
    }
    if (!found) continue;
    // Speed along the wall: the velocity without its component into the wall.
    const into = s.vx * nx + s.vz * nz;
    const along = Math.hypot(s.vx - into * nx, s.vz - into * nz);
    if (along > bestAlong) {
      bestAlong = along;
      best = { nx, nz };
    }
  }
  return best;
}

function endWallRun(s: PlayerState): void {
  if (!s.wallRunning) return;
  s.wallRunning = false;
  s.wallRunTime = 0;
  s.wallCooldown = P.wallRunCooldown;
}

/**
 * Start, keep or end a wall run. To start: in the air and clear of the floor, moving along a
 * wall fast enough, holding a direction that follows the wall. To keep going: still beside the
 * same wall, still moving along it, still holding a direction, time not up, slide key released.
 */
function updateWallRun(
  s: PlayerState,
  input: PlayerInput,
  wish: Wish,
  world: CollisionWorld,
): void {
  const ok =
    !s.onGround &&
    !s.sliding &&
    !s.crouching &&
    !input.slide &&
    wish.mag > 0 &&
    s.wallRunTime < P.wallRunMaxTime &&
    !(input.jump && s.wallJumps >= P.wallJumpMax);
  const c = ok ? findWall(world, s) : null;
  if (!c) {
    endWallRun(s);
    return;
  }
  const into = s.vx * c.nx + s.vz * c.nz;
  const tx = s.vx - into * c.nx;
  const tz = s.vz - into * c.nz;
  const along = Math.hypot(tx, tz);
  if (!s.wallRunning) {
    if (along < P.wallRunMinSpeed) return;
    if ((wish.x * tx + wish.z * tz) / along < P.wallRunWish) return;
    if (s.y - supportHeight(world, s.x, s.z, s.y) < P.wallRunMinHeight) return;
    s.wallRunning = true;
    s.wallRunTime = 0;
    s.vy = Math.min(s.vy, P.wallRunMaxRise); // a jump's rise does not carry up the wall
  } else if (along < P.wallRunExitSpeed) {
    endWallRun(s);
    return;
  }
  s.wallNormalX = c.nx;
  s.wallNormalZ = c.nz;
}

/** Slide along the wall at (at least) wall-run speed, pressed lightly to it, barely falling. */
function runAlongWall(s: PlayerState, dt: number): void {
  const nx = s.wallNormalX;
  const nz = s.wallNormalZ;
  const into = s.vx * nx + s.vz * nz;
  const tx = s.vx - into * nx;
  const tz = s.vz - into * nz;
  const along = Math.hypot(tx, tz);
  const speed = Math.max(along, P.wallRunSpeed);
  s.vx = (tx / along) * speed - nx * P.wallRunStick;
  s.vz = (tz / along) * speed - nz * P.wallRunStick;
  s.vy = Math.max(-P.wallRunMaxFall, s.vy - P.gravity * P.wallRunGravityScale * dt);
  s.wallRunTime += dt;
  s.jumpBuffer = 0;
}

/** Kick off the wall: away from it, up, keeping the speed along it. Gives back one air jump. */
function wallJump(s: PlayerState): void {
  const nx = s.wallNormalX;
  const nz = s.wallNormalZ;
  const into = s.vx * nx + s.vz * nz;
  s.vx = s.vx - into * nx + nx * P.wallJumpKick;
  s.vz = s.vz - into * nz + nz * P.wallJumpKick;
  s.vy = P.wallJumpSpeed;
  s.wallJumps += 1;
  s.airJumps = Math.min(P.maxAirJumps, s.airJumps + 1);
  s.jumpBuffer = 0;
  s.wallRunning = false;
  s.wallRunTime = 0;
  s.wallCooldown = P.wallRunCooldown;
}

/** A fresh jump press in the air, touching a wall: wall jump instead of an air jump. */
function tryWallJump(s: PlayerState, input: PlayerInput, world: CollisionWorld): boolean {
  if (!input.jump || s.onGround || s.coyote > 0 || s.wallJumps >= P.wallJumpMax) return false;
  const c = findWall(world, s);
  if (!c) return false;
  s.wallNormalX = c.nx;
  s.wallNormalZ = c.nz;
  wallJump(s);
  return true;
}

// --- Mantle ----------------------------------------------------------------

function tryStartMantle(s: PlayerState, world: CollisionWorld, wish: Wish, hit: WallHit): void {
  if (s.sliding || s.crouching || s.dashTime > 0) return;
  // Must be pushing into the wall we hit.
  const into = (hit.axis === "x" ? wish.x : wish.z) * hit.sign;
  if (into < 0.3) return;

  const top = hit.box.maxY;
  const rise = top - s.y;
  if (rise <= P.stepHeight || rise > P.mantleReach) return;

  const hw = P.halfWidth;
  let tx = s.x;
  let tz = s.z;
  if (hit.axis === "x") {
    tx = hit.sign > 0 ? hit.box.minX + hw + P.mantleInset : hit.box.maxX - hw - P.mantleInset;
  } else {
    tz = hit.sign > 0 ? hit.box.minZ + hw + P.mantleInset : hit.box.maxZ - hw - P.mantleInset;
  }
  // Need room to stand at the destination, with something solid under us.
  if (blocked(world, playerBox(tx, top, tz, P.standHeight))) return;
  if (top - supportHeight(world, tx, tz, top) > P.groundEps) return;

  endWallRun(s);
  s.mantling = true;
  s.mantleT = 0;
  s.sliding = false;
  s.crouching = false;
  s.mantleFromX = s.x;
  s.mantleFromY = s.y;
  s.mantleFromZ = s.z;
  s.mantleToX = tx;
  s.mantleToY = top;
  s.mantleToZ = tz;
  s.vx = 0;
  s.vy = 0;
  s.vz = 0;
}

/** Rise up the wall first (60%), then move over the ledge. */
function stepMantle(s: PlayerState, dt: number): void {
  const split = 0.6;
  s.mantleT += dt;
  const u = Math.min(1, s.mantleT / P.mantleDuration);
  if (u < split) {
    const k = u / split;
    s.x = s.mantleFromX;
    s.z = s.mantleFromZ;
    s.y = s.mantleFromY + (s.mantleToY - s.mantleFromY) * k;
  } else {
    const k = (u - split) / (1 - split);
    s.x = s.mantleFromX + (s.mantleToX - s.mantleFromX) * k;
    s.z = s.mantleFromZ + (s.mantleToZ - s.mantleFromZ) * k;
    s.y = s.mantleToY;
  }
  s.vx = 0;
  s.vy = 0;
  s.vz = 0;
  if (u >= 1) {
    const dx = s.mantleToX - s.mantleFromX;
    const dz = s.mantleToZ - s.mantleFromZ;
    const len = Math.hypot(dx, dz);
    s.mantling = false;
    s.mantleT = 0;
    s.onGround = true;
    s.airJumps = P.maxAirJumps;
    if (len > 0) {
      s.vx = (dx / len) * P.mantleExitSpeed;
      s.vz = (dz / len) * P.mantleExitSpeed;
    }
  }
}
