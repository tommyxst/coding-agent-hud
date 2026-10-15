import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/model';
import { loadSettings, parseSettings, saveSettings, SETTINGS_KEY, SETTINGS_VERSION } from '../src/settings';

const encode = (settings: unknown, version = SETTINGS_VERSION) => JSON.stringify({ version, settings });
describe('versioned local settings', () => {
  it('defaults to explicit privacy-safe settings only when no saved value exists', () => {
    const loaded = loadSettings({ getItem: () => null });
    expect(loaded.status).toBe('new');
    expect(loaded.settings).toEqual(DEFAULT_SETTINGS);
    expect(loaded.settings.showCommandDetail).toBe(false);
    expect(loaded.settings.showRepositoryPath).toBe(false);
  });
  it('round-trips all settings, but never includes sessions or paths', () => {
    const setItem = vi.fn();
    saveSettings({ setItem }, DEFAULT_SETTINGS);
    expect(setItem).toHaveBeenCalledWith(SETTINGS_KEY, encode(DEFAULT_SETTINGS));
    expect(parseSettings(setItem.mock.calls[0][1])).toEqual(DEFAULT_SETTINGS);
  });
  it.each([
    'not json', encode(DEFAULT_SETTINGS, 999), encode(null),
    encode({ ...DEFAULT_SETTINGS, opacity: 0 }),
    encode({ ...DEFAULT_SETTINGS, opacity: 1.01 }),
    encode({ ...DEFAULT_SETTINGS, clickThrough: 'true' }),
    encode({ ...DEFAULT_SETTINGS, showCommandDetail: undefined }),
    encode({ ...DEFAULT_SETTINGS, doneDisplayMs: 0 }),
    encode({ ...DEFAULT_SETTINGS, doneDisplayMs: 7000.5 }),
    encode({ ...DEFAULT_SETTINGS, extra: 'session data' }),
  ])('rejects invalid schema instead of silently treating it as a successful load (%s)', raw => {
    expect(() => parseSettings(raw)).toThrow();
    const loaded = loadSettings({ getItem: () => raw });
    expect(loaded.status).toBe('error');
    if (loaded.status === 'error') expect(loaded.error.length).toBeGreaterThan(0);
  });
  it('reports unavailable local storage without swallowing its error', () => {
    const loaded = loadSettings({ getItem: () => { throw new Error('Storage denied'); } });
    expect(loaded.status).toBe('error');
    if (loaded.status === 'error') expect(loaded.error).toBe('Storage denied');
  });
  it('propagates persistence errors, so UI can state the setting was not saved', () => {
    expect(() => saveSettings({ setItem: () => { throw new Error('Quota exceeded'); } }, DEFAULT_SETTINGS)).toThrow('Quota exceeded');
  });
});

it('migrates valid v1 settings without discarding previous privacy and appearance choices', () => {
  const { fontSize, alwaysOnTop, ...legacy } = DEFAULT_SETTINGS;
  expect(parseSettings(encode({ ...legacy, opacity: 0.7, showRepositoryPath: true }, 1))).toEqual({ ...DEFAULT_SETTINGS, opacity: 0.7, showRepositoryPath: true });
  expect(() => parseSettings(encode({ ...legacy, extra: true }, 1))).toThrow();
});

it.each([11, 21, 15.5, '15', null])('rejects invalid font size %s', fontSize => {
  expect(() => parseSettings(encode({ ...DEFAULT_SETTINGS, fontSize }))).toThrow();
});

it('persists font and topmost choices through save/load', () => {
  let raw = '';
  const settings = { ...DEFAULT_SETTINGS, fontSize: 20, alwaysOnTop: false };
  saveSettings({ setItem: (_key, value) => { raw = value; } }, settings);
  expect(loadSettings({ getItem: () => raw }).settings).toEqual(settings);
});
