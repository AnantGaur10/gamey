// Fixed-timestep driver: the ONE clock all physics runs on.
//
// Spec (specs/crazygames/gameplay.md): physics must be consistent across
// 60/144/165Hz — delta-time, never frame count. So physics only ever advances
// in fixed STEP-sized increments, however many frames (or fractions of one)
// fit in the elapsed time; rendering never advances physics, it interpolates
// the last two physics states by the returned alpha.
//
// Pure: no THREE / DOM, so the game loop and the refresh-rate test share it.

export const STEP = 1 / 60;
/** Frame dt clamp (spiral-of-death guard): below 10fps the game slows down
    instead of running ever-longer catch-up bursts. */
export const MAX_FRAME_DT = 0.1;

export interface FixedStepper {
  /** Advance by a frame's elapsed time `dt` (seconds). Runs `fixedFn(step)`
      zero or more times; returns alpha in [0,1) = how far the render time is
      between the previous and the latest physics state. */
  advance(dt: number, fixedFn: (step: number) => void): number;
  /** Fixed steps executed so far (diagnostics/tests). */
  readonly steps: number;
}

export function createFixedStepper(step = STEP, maxFrameDt = MAX_FRAME_DT): FixedStepper {
  let acc = 0;
  let steps = 0;
  return {
    advance(dt, fixedFn) {
      acc += Math.min(Math.max(dt, 0), maxFrameDt);
      // epsilon: 0.1s of 1/60 steps must be 6, not 5 + 0.99999 (float drift)
      while (acc >= step - 1e-9) {
        fixedFn(step);
        acc -= step;
        steps++;
      }
      if (acc < 0) acc = 0;
      return acc / step;
    },
    get steps() { return steps; },
  };
}
