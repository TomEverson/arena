import { spawnState, stepPlayer } from "../movement";
import type { CollisionWorld, PlayerInput, PlayerState } from "../types";
import { emptyInput } from "../types";
import { CHECKPOINT_EVERY, type Vector, VECTOR_DT, type VectorWorld } from "./format";

export interface Scenario {
  name: string;
  description: string;
  world: VectorWorld;
  start: [number, number, number];
  overrides?: Partial<PlayerState>;
  ticks: number;
  /**
   * Creates the input function for one run (so closures can keep per-run state).
   * The function gives the input for the coming tick, given the tick index and the state before it.
   */
  input: () => (tick: number, s: PlayerState) => Partial<PlayerInput>;
  /**
   * Throws if the recorded behaviour is not what the scenario claims to demonstrate.
   * trace[0] is the initial state; trace[i] is the state after i ticks.
   */
  verify: (trace: PlayerState[]) => void;
}

/** Run a scenario against the live sim and capture it as a vector. */
export function recordScenario(
  sc: Scenario,
  world: CollisionWorld,
): { vector: Vector; trace: PlayerState[] } {
  const initial: PlayerState = { ...spawnState(...sc.start), ...sc.overrides };
  const trace: PlayerState[] = [initial];
  const steps: Vector["steps"] = [];
  const checkpoints: Vector["checkpoints"] = [];

  const inputFor = sc.input();
  let s = initial;
  for (let t = 0; t < sc.ticks; t++) {
    const input: PlayerInput = { ...emptyInput(), ...inputFor(t, s) };
    const last = steps[steps.length - 1];
    if (last && JSON.stringify(last.input) === JSON.stringify(input)) last.ticks++;
    else steps.push({ ticks: 1, input });

    s = stepPlayer(s, input, world, VECTOR_DT);
    trace.push(s);
    const done = t + 1;
    if (done % CHECKPOINT_EVERY === 0 || done === sc.ticks)
      checkpoints.push({ tick: done, state: s });
  }

  return {
    vector: {
      name: sc.name,
      description: sc.description,
      dt: VECTOR_DT,
      world: sc.world,
      initial,
      steps,
      checkpoints,
    },
    trace,
  };
}
