import { beforeAll, describe, expect, it, vi } from 'vitest';

let terminalSpeech: typeof import('../src/stage/store').terminalSpeech;
let handle: typeof import('../src/stage/store').handle;
let getState: typeof import('../src/stage/store').getState;

beforeAll(async () => {
  vi.stubGlobal('location', { search: '' });
  ({ terminalSpeech, handle, getState } = await import('../src/stage/store'));
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

describe('terminal visibility setting', () => {
  it('is visible by default and follows hide/show events immediately', () => {
    expect(getState().terminalVisible).toBe(true);
    handle({ v: 1, type: 'terminal', visible: false, at: Date.now() });
    expect(getState().terminalVisible).toBe(false);
    handle({ v: 1, type: 'terminal', visible: true, at: Date.now() });
    expect(getState().terminalVisible).toBe(true);
  });
});
