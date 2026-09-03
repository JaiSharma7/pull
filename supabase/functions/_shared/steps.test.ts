import { describe, expect, it } from 'vitest';
import { NEEDS, nextStep, STEPS } from './steps.ts';

describe('NEEDS', () => {
  it('declares inputs for every step', () => {
    // `Record<Step, …>` already makes this a type error, but the runtime check is
    // what fails when the file is edited under `as never` or from JavaScript.
    for (const step of STEPS) expect(NEEDS[step]).toBeDefined();
  });

  it('never names a later step', () => {
    // A step can only read what has already run. Naming a later one would not
    // throw -- `job_step_outputs` would simply return nothing for it -- so the step
    // would run with an input silently missing.
    for (const step of STEPS) {
      const at = STEPS.indexOf(step);
      for (const need of NEEDS[step]) {
        expect(STEPS.indexOf(need), `${step} needs ${need}, which runs after it`).toBeLessThan(at);
      }
    }
  });

  it('names no step twice', () => {
    for (const step of STEPS) expect(new Set(NEEDS[step]).size).toBe(NEEDS[step].length);
  });

  it('fetches the source text for five steps, not ten', () => {
    // The number the migration comment states. Asserted so the claim cannot go
    // stale silently: if the reuse marker moves out of `acquire`'s output, this
    // should come down, and if a new step starts reading `acquire` it goes up and
    // somebody has to say why.
    const readsAcquire = STEPS.filter((s) => NEEDS[s].includes('acquire'));
    expect(readsAcquire).toEqual(['chunk', 'synthesize', 'template', 'critic', 'publish']);
  });
});

describe('nextStep', () => {
  it('walks the line and stops at the end', () => {
    expect(nextStep('resolve_identity')).toBe('acquire');
    expect(nextStep('publish')).toBeNull();
  });
});
