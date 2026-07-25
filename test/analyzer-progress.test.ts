import { describe, expect, it } from 'vitest';
import { parseAnalyzerProgressLine } from '../packages/web/src/analyzer-progress.js';

describe('analyzer progress protocol', () => {
  it('parses a structured progress marker embedded in stderr', () => {
    expect(
      parseAnalyzerProgressLine(
        '[motionscore] progress {"percent":58,"stage":"Stem detection","message":"Found 4 active components"}',
      ),
    ).toEqual({
      percent: 58,
      stage: 'Stem detection',
      message: 'Found 4 active components',
    });
  });

  it.each([
    'ordinary diagnostic text',
    '[motionscore] stems: separating on CUDA',
    '[motionscore] progress not-json',
    '[motionscore] progress {"percent":100,"stage":"Done","message":"Reserved for server"}',
    '[motionscore] progress {"percent":45,"stage":"","message":"Missing stage"}',
    '[motionscore] progress {"percent":45,"stage":"Analysis","message":12}',
  ])('ignores malformed or non-progress lines: %s', (line) => {
    expect(parseAnalyzerProgressLine(line)).toBeNull();
  });
});
