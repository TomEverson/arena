import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { type ArmSolution, solveArm } from "./character";

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
