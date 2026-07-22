import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Toolchain smoke test.
 *
 * Verifies that the monorepo test infrastructure is wired correctly:
 * Vitest runs TypeScript, and fast-check integrates for property-based
 * testing. This is a scaffolding sanity check, not a spec property test
 * (the numbered correctness properties are implemented in their own tasks).
 */
describe('toolchain', () => {
  it('runs Vitest against TypeScript sources', () => {
    expect(1 + 1).toBe(2);
  });

  it('integrates fast-check for property-based testing', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
    );
  });
});
