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
import { PARAMS as P } from "./params";
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
    climbing: false,
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
  };
}

export const hSpeed = (s: PlayerState): number => Math.hypot(s.vx, s.vz);
export const bodyHeight = (s: PlayerState): number => (s.sliding ? P.slideHeight : P.standHeight);
export const eyeHeight = (s: PlayerState): number => (s.sliding ? P.slideEye : P.standEye);

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
  /** Ground speed multiplier (1, or less while aiming down sights). */
  speed: number;
}

function wishOf(input: PlayerInput): Wish {
  let mx = input.moveX;
  let mz = input.moveZ;
  const len = Math.hypot(mx, mz);
  if (len < 1e-9) return { x: 0, z: 0, mag: 0, speed: 1 };
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
    speed: input.ads ? P.adsSpeedMult : 1,
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
  s.coyote = s.onGround ? P.coyoteTime : Math.max(0, s.coyote - dt);
  s.jumpBuffer = input.jump ? P.jumpBufferTime : Math.max(0, s.jumpBuffer - dt);

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
  if (input.dash && s.dashCharges >= 1 && !wasDashing) {
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

  const wall =
    s.dashTime > 0 || s.sliding || !input.jumpHeld ? null : findClimbWall(world, s, input.yaw);
  s.climbing = wall !== null;

  if (s.dashTime > 0) {
    // Dash overrides everything: constant velocity, no gravity.
    s.vx = s.dashDirX * P.dashSpeed;
    s.vz = s.dashDirZ * P.dashSpeed;
    s.vy = 0;
    s.dashTime = Math.max(0, s.dashTime - dt);
  } else if (wall) {
    // Climbing: stuck to the wall, moving straight up, no gravity.
    s.vx = 0;
    s.vz = 0;
    s.vy = P.climbSpeed;
    s.jumpBuffer = 0;
  } else {
    updateSlide(s, input, world, dt);
    updateHorizontalVelocity(s, wish, dt);
    tryJump(s, input, world);
    if (!s.onGround) s.vy = Math.max(-P.terminalVelocity, s.vy - P.gravity * dt);
    else if (s.vy < 0) s.vy = 0;
  }

  const hit = integrate(s, world, dt);

  if (wasDashing && s.dashTime <= 0) {
    // Dash just ended: keep some momentum.
    s.vx = s.dashDirX * P.dashExitSpeed;
    s.vz = s.dashDirZ * P.dashExitSpeed;
  }

  probeGround(s, world, wasGround);

  if (hit && !s.onGround) tryStartMantle(s, world, wish, hit);
  else if (wall && s.climbing && !s.onGround) {
    // Near the top of a climbable wall: pull over the edge.
    const rise = wall.box.maxY - s.y;
    if (rise <= P.climbTopOut)
      tryStartMantle(
        s,
        world,
        { x: -Math.sin(input.yaw), z: -Math.cos(input.yaw), mag: 1, speed: 1 },
        wall,
      );
  }
  if (s.mantling) s.climbing = false;

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
    if (input.slide && s.onGround && speed >= P.slideMinSpeed) {
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

function updateHorizontalVelocity(s: PlayerState, wish: Wish, dt: number): void {
  if (s.sliding && s.onGround && hSpeed(s) >= P.slideEndSpeed) {
    // Momentum slide: fixed direction, linear decay.
    reduceSpeed(s, P.slideDecel * dt, 0);
    return;
  }
  if (s.onGround) {
    // Still low (e.g. under a ceiling after the slide ran out): crouch-walk.
    const wishSpeed = (s.sliding ? P.crouchSpeed : P.runSpeed) * wish.mag * wish.speed;
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
  if (wish.mag > 0) accelerate(s, wish, P.runSpeed * wish.mag, P.airAccel, dt);
  const cap = Math.max(before, P.runSpeed);
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
    }
    s.vy = P.jumpSpeed;
    s.onGround = false;
    s.coyote = 0;
    s.jumpBuffer = 0;
    return;
  }
  // Air jump: only on a fresh press (a buffered press must not burn it just before landing).
  if (input.jump && !canGroundJump && s.airJumps > 0) {
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
    s.y = support;
    s.vy = 0;
  } else {
    s.onGround = false;
  }
}

// --- Climb -----------------------------------------------------------------

/**
 * The climbable surface the player is touching and facing, if any. Looks for a
 * climbable box just beyond the player's side along the facing direction.
 */
function findClimbWall(world: CollisionWorld, s: PlayerState, yaw: number): WallHit | null {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const height = bodyHeight(s);
  const axis: "x" | "z" = Math.abs(fx) >= Math.abs(fz) ? "x" : "z";
  const facing = axis === "x" ? fx : fz;
  if (Math.abs(facing) < P.climbFacing) return null;
  const sign: 1 | -1 = facing > 0 ? 1 : -1;
  const probe = playerBox(
    s.x + (axis === "x" ? sign * P.climbReach : 0),
    s.y,
    s.z + (axis === "z" ? sign * P.climbReach : 0),
    height,
  );
  for (const b of world.boxes) {
    if (b.climbable && overlaps(probe, b) && b.maxY > s.y + 1e-6) return { box: b, axis, sign };
  }
  return null;
}

// --- Mantle ----------------------------------------------------------------

function tryStartMantle(s: PlayerState, world: CollisionWorld, wish: Wish, hit: WallHit): void {
  if (s.sliding || s.dashTime > 0) return;
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

  s.mantling = true;
  s.mantleT = 0;
  s.sliding = false;
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
