import type * as THREE from "three";

import { type BodyState, CharacterBody, type CharacterLook, HERO_LOOKS } from "./character";
import type { Pose } from "./net/interpolation";
import { EntityFlags, EntityKinds } from "./net/protocol.gen";
import { castRay } from "./sim/hitscan";
import { SKILL } from "./sim/params";
import type { CollisionWorld } from "./sim/types";

interface View {
  look: CharacterLook;
  body: CharacterBody;
  state: BodyState;
  lastX: number;
  lastY: number;
  lastZ: number;
  /** The way it was last seen moving (radians), for finding the wall it runs along. */
  heading: number;
}

/** How far to look for the wall beside a wall runner (metres). */
const WALL_PROBE = 1;

/**
 * Bodies for everyone else, drawn with the shared character body (character.ts): other players
 * as the hero they chose, practice-range targets as the dummy with empty hands. Visual only: hitboxes live in the sim. They flash when hit.
 */
export class RemoteViews {
  private readonly views = new Map<number, View>();

  /** `world` gives the current level's walls (only read, to find the wall beside a wall runner). */
  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: () => CollisionWorld,
  ) {}

  /** Flash a body for a moment (a confirmed hit). */
  flash(id: number): void {
    this.views.get(id)?.body.hit();
  }

  /** Per frame. `viewer` is the camera position: standing bodies turn to face it. */
  update(poses: Pose[], frameDt: number, viewer: THREE.Vector3): void {
    const seen = new Set<number>();
    for (const pose of poses) {
      seen.add(pose.id);
      const target = pose.kind === EntityKinds.target;
      // Practice-range targets are the plain dummy; a player is whichever hero they chose.
      const look = target ? "dummy" : (HERO_LOOKS[pose.hero] ?? "trooper");
      let v = this.views.get(pose.id);
      if (v && v.look !== look) {
        this.scene.remove(v.body.root); // they changed hero: a new body
        v = undefined;
      }
      if (!v) {
        v = {
          look,
          body: new CharacterBody(this.scene, pose.id, look),
          state: { x: 0, y: 0, z: 0, onGround: true, sliding: false, alive: true, armed: true },
          lastX: pose.x,
          lastY: pose.y,
          lastZ: pose.z,
          heading: 0,
        };
        this.views.set(pose.id, v);
      }
      const s = v.state;
      s.x = pose.x;
      s.y = pose.y;
      s.z = pose.z;
      s.sliding = (pose.flags & EntityFlags.sliding) !== 0;
      s.wallRunning = (pose.flags & EntityFlags.wallRunning) !== 0;
      s.meleeing = (pose.flags & EntityFlags.meleeing) !== 0;
      s.slashing = (pose.flags & EntityFlags.slashing) !== 0;
      s.rolling = (pose.flags & EntityFlags.rolling) !== 0;
      s.divePrep = (pose.flags & EntityFlags.divePrep) !== 0;
      s.diveLeft = s.rolling ? this.diveLeft(pose, v, frameDt) : undefined;
      s.armed = !target && (pose.flags & EntityFlags.emptyHanded) === 0; // a target holds nothing
      s.weapon =
        (pose.flags & EntityFlags.holdingSpear) !== 0
          ? 2
          : (pose.flags & EntityFlags.holdingSniper) !== 0
            ? 1
            : 0;
      s.crouching = (pose.flags & EntityFlags.crouching) !== 0;
      s.dashing = (pose.flags & EntityFlags.dashing) !== 0;
      s.alive = (pose.flags & EntityFlags.dead) === 0;
      // Poses carry no on-ground flag: a body whose height is not changing is on the ground.
      s.onGround = Math.abs(pose.y - v.lastY) < 0.005;
      const dx = pose.x - v.lastX;
      const dz = pose.z - v.lastZ;
      if (Math.hypot(dx, dz) > 1e-4) v.heading = Math.atan2(dx, dz);
      s.wallSide = s.wallRunning ? this.wallSide(pose, v.heading) : 0;
      v.lastX = pose.x;
      v.lastY = pose.y;
      v.lastZ = pose.z;
      v.body.update(s, frameDt, viewer);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        this.scene.remove(v.body.root);
        this.views.delete(id);
      }
    }
  }

  /**
   * About how long until a diving body lands (seconds): a ray from its feet along the way it is
   * moving, to the first wall or floor. Undefined when it is not moving or nothing is ahead.
   */
  private diveLeft(pose: Pose, v: View, frameDt: number): number | undefined {
    const dx = pose.x - v.lastX;
    const dy = pose.y - v.lastY;
    const dz = pose.z - v.lastZ;
    const step = Math.hypot(dx, dy, dz);
    if (step < 1e-4 || frameDt <= 0) return undefined;
    const reach = SKILL.rollSpeed * SKILL.rollTime;
    const hit = castRay(
      this.world(),
      [],
      [pose.x, pose.y + 0.05, pose.z],
      [dx / step, dy / step, dz / step],
      reach,
    );
    return hit.kind === "world" ? hit.t / (step / frameDt) : undefined;
  }

  /**
   * Which side of a wall runner the wall is on, in its own space (+1 its +X side, -1 its -X
   * side, 0 if no wall is found): a short ray each way from chest height. Poses carry only the
   * wall-run flag, not the wall.
   */
  private wallSide(pose: Pose, heading: number): number {
    // The body's own +X axis in the world, when it faces `heading` (character.ts turns it so).
    const ax = Math.cos(heading);
    const az = -Math.sin(heading);
    const from: [number, number, number] = [pose.x, pose.y + 1, pose.z];
    const right = castRay(this.world(), [], from, [ax, 0, az], WALL_PROBE);
    const left = castRay(this.world(), [], from, [-ax, 0, -az], WALL_PROBE);
    if (right.kind === "world" && (left.kind !== "world" || right.t <= left.t)) return 1;
    return left.kind === "world" ? -1 : 0;
  }
}
