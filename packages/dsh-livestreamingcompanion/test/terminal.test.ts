import { beforeAll, describe, expect, it, vi } from 'vitest';

let terminalSpeech: typeof import('../src/stage/store').terminalSpeech;

beforeAll(async () => {
  vi.stubGlobal('location', { search: '' });
  ({ terminalSpeech } = await import('../src/stage/store'));
});

describe('terminal speech length', () => {
  it('keeps up to 100 characters intact', () => {
    const text = '字'.repeat(100);
    expect(terminalSpeech(text)).toBe(text);
  });

  it('adds an ellipsis only after 100 characters', () => {
    const text = '字'.repeat(101);
    expect(terminalSpeech(text)).toBe(`${'字'.repeat(100)}…`);
  });

  it('counts Unicode characters rather than UTF-16 code units', () => {
    const text = '🐟'.repeat(100);
    expect(terminalSpeech(text)).toBe(text);
  });
});
