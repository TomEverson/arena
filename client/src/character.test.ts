import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  type ArmSolution,
  type BodyState,
  CharacterBody,
  type CharacterLook,
  solveArm,
} from "./character";

// The arm as built: a shoulder at (shoulderX, 0.46, 0) hanging down -Y, an elbow 0.28 below it,
// the middle of the fist 0.32 below the elbow. The shoulder group is rotated by `q` and the
// elbow bends the forearm about X.
const UPPER = 0.28;
const FORE = 0.32;
const SHOULDER_Y = 0.46;

/** Where the middle of the fist ends up for these joints (forward kinematics). */
function hand(shoulderX: number, r: ArmSolution): [number, number, number] {
  const p = new THREE.Vector3(0, -UPPER - FORE * Math.cos(r.elbow), -FORE * Math.sin(r.elbow));
  p.applyQuaternion(r.q);
  return [shoulderX + p.x, SHOULDER_Y + p.y, p.z];
}

const fresh = (): ArmSolution => ({ q: new THREE.Quaternion(), elbow: 0 });

describe("solveArm", () => {
  it("puts the hand exactly on any point it can reach", () => {
    const targets: [number, number, number][] = [
      [0.05, 0.1, 0.11], // the right grip, rifle held low
      [0.05, 0.08, 0.41], // the left hand, front of the receiver
      [0.06, 0.33, 0.44], // aiming
      [0.2, 0.0, 0.0], // straight down
      [0.4, 0.46, 0.2], // out to the side
      [0.0, 0.9, 0.3], // overhead
    ];
    for (const shoulderX of [-0.2, 0.2]) {
      for (const [tx, ty, tz] of targets) {
        const reach = Math.hypot(tx - shoulderX, ty - SHOULDER_Y, tz);
        if (reach > UPPER + FORE - 1e-3 || reach < Math.abs(UPPER - FORE) + 1e-3) continue;
        const r = solveArm(shoulderX, tx, ty, tz, fresh());
        const [hx, hy, hz] = hand(shoulderX, r);
        expect(hx).toBeCloseTo(tx, 6);
        expect(hy).toBeCloseTo(ty, 6);
        expect(hz).toBeCloseTo(tz, 6);
      }
    }
  });

  it("bends the elbow forward (never backward) and straightens it at full reach", () => {
    const bent = solveArm(0.2, 0.2, 0.3, 0.2, fresh());
    expect(bent.elbow).toBeLessThan(0);
    const out = solveArm(0.2, 0.2, 0.46, UPPER + FORE + 0.5, fresh()); // far too far
    expect(Math.abs(out.elbow)).toBeLessThan(0.05);
  });

  it("points a straight arm at a target that is out of reach", () => {
    const r = solveArm(0.2, 0.2, 0.46, 5, fresh()); // five metres ahead
    const [hx, hy, hz] = hand(0.2, r);
    expect(hz).toBeGreaterThan(0.55); // reaches forward
    expect(Math.hypot(hx - 0.2, hy - SHOULDER_Y, hz)).toBeCloseTo(UPPER + FORE, 3);
  });

  it("hangs straight down when the hand is right below the shoulder", () => {
    const r = solveArm(0.2, 0.2, SHOULDER_Y - UPPER - FORE + 1e-3, 0, fresh());
    expect(Math.abs(r.elbow)).toBeLessThan(0.15);
    // The arm still points down (it may twist about its own axis, which cannot be seen).
    const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(r.q);
    expect(dir.angleTo(new THREE.Vector3(0, -1, 0))).toBeLessThan(0.2);
  });
});

describe("character looks", () => {
  /** The body's own meshes: everything except the rifle group (the one holding the muzzle flash). */
  function bodyMeshes(body: CharacterBody): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const walk = (o: THREE.Object3D) => {
      const isGun = o.children.some(
        (c) => c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial,
      );
      if (isGun || !o.visible) return;
      if (o instanceof THREE.Mesh) out.push(o as THREE.Mesh);
      o.children.forEach(walk);
    };
    walk(body.root);
    return out;
  }

  it.each<CharacterLook>(["trooper", "assassin"])(
    "%s stands inside the hitbox, feet on the floor, head in the head zone",
    (look) => {
      const body = new CharacterBody(new THREE.Scene(), 0, look);
      body.root.updateMatrixWorld(true);
      const meshes = bodyMeshes(body);
      expect(meshes.length).toBeGreaterThan(15);
      const all = new THREE.Box3();
      for (const m of meshes) all.expandByObject(m);
      // The hitbox is 0.6 x 1.8 x 0.6 m. Toes may poke a little past the front (as the trooper's do).
      expect(all.min.x).toBeGreaterThanOrEqual(-0.3);
      expect(all.max.x).toBeLessThanOrEqual(0.3);
      expect(all.min.z).toBeGreaterThanOrEqual(-0.3);
      expect(all.max.z).toBeLessThanOrEqual(0.3);
      expect(all.min.y).toBeCloseTo(0, 2);
      expect(all.max.y).toBeLessThanOrEqual(1.8);
      expect(all.max.y).toBeGreaterThan(1.7); // and it fills the height
    },
  );

  it("gives the assassin a narrower body than the trooper", () => {
    const width = (look: CharacterLook) => {
      const body = new CharacterBody(new THREE.Scene(), 0, look);
      body.root.updateMatrixWorld(true);
      // The torso and legs only: below the shoulders, ignoring the arms (x within 0.17 of the middle).
      let w = 0;
      for (const m of bodyMeshes(body)) {
        const b = new THREE.Box3().setFromObject(m);
        if (b.max.y < 1.3 && Math.abs((b.min.x + b.max.x) / 2) < 0.12)
          w = Math.max(w, b.max.x - b.min.x);
      }
      return w;
    };
    expect(width("assassin")).toBeLessThan(width("trooper"));
  });
});

describe("grappling rig (assassin)", () => {
  const still = (extra: Partial<BodyState> = {}): BodyState => ({
    x: 0,
    y: 0,
    z: 0,
    onGround: true,
    sliding: false,
    alive: true,
    armed: true,
    ...extra,
  });
  const viewer = new THREE.Vector3(0, 1.6, 5);
  /** Visible meshes that are not part of the body's own build: the hand blade and the cable. */
  const visibleNames = (body: CharacterBody) => {
    let n = 0;
    body.root.traverseVisible((o) => {
      if (o instanceof THREE.Mesh) n++;
    });
    return n;
  };

  it.each<[CharacterLook, boolean]>([
    ["assassin", true],
    ["trooper", false],
  ])("%s draws a blade for the melee swing: %s", (look, slashes) => {
    const body = new CharacterBody(new THREE.Scene(), 0, look);
    body.update(still(), 1 / 60, viewer);
    const before = visibleNames(body);
    // Into the swing, past the draw (the swing lasts 0.35 s).
    for (let i = 0; i < 9; i++) body.update(still({ meleeing: true }), 1 / 60, viewer);
    const during = visibleNames(body);
    if (slashes) expect(during).toBeGreaterThan(before);
    else expect(during).toBe(before);
    // Put away again once the swing is over.
    for (let i = 0; i < 40; i++) body.update(still(), 1 / 60, viewer);
    expect(visibleNames(body)).toBe(before);
  });

  it("fires a cable at the wall on a wall run, on the wall's side, and reels it in after", () => {
    const body = new CharacterBody(new THREE.Scene(), 0, "assassin");
    const run = (wallSide: number) =>
      still({ onGround: false, wallRunning: true, wallSide, y: 1.6 });
    body.update(still(), 1 / 60, viewer);
    const before = visibleNames(body);
    for (let i = 0; i < 20; i++) body.update(run(1), 1 / 60, viewer);
    expect(visibleNames(body)).toBe(before + 1);
    // The cable runs up and ahead, on the +X side.
    const cable = new THREE.Box3();
    body.root.updateMatrixWorld(true);
    body.root.traverseVisible((o) => {
      if (o instanceof THREE.Mesh && o.scale.z > 1) cable.expandByObject(o);
    });
    body.root.worldToLocal(cable.max);
    expect(cable.max.y).toBeGreaterThan(2.5);
    for (let i = 0; i < 20; i++) body.update(still(), 1 / 60, viewer);
    expect(visibleNames(body)).toBe(before);
  });

  it("fires no cable when the wall's side is unknown", () => {
    const body = new CharacterBody(new THREE.Scene(), 0, "assassin");
    body.update(still(), 1 / 60, viewer);
    const before = visibleNames(body);
    for (let i = 0; i < 20; i++)
      body.update(still({ onGround: false, wallRunning: true, y: 1.6 }), 1 / 60, viewer);
    expect(visibleNames(body)).toBe(before);
  });
});
