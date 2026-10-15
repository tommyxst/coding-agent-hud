import { DEFAULT_SETTINGS, type HudSettings } from './model';
import { errorText } from './state';

export const SETTINGS_KEY = 'coding-agent-hud:settings:v1';
export const SETTINGS_VERSION = 2;
export const OPACITY_MIN = 0.45;
export const OPACITY_MAX = 1;
export const DONE_DISPLAY_MIN = 1000;
export const DONE_DISPLAY_MAX = 60000;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 20;

export type SettingsLoad =
  | { status: 'loaded' | 'new'; settings: HudSettings }
  | { status: 'error'; settings: HudSettings; error: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSettings(raw: string): HudSettings {
  const envelope: unknown = JSON.parse(raw);
  if (!object(envelope) || ![1, SETTINGS_VERSION].includes(envelope.version as number) || !object(envelope.settings)) {
    throw new Error('设置版本或结构不受支持；原始配置未被覆盖。');
  }
  const value = envelope.settings;
  const expected = Object.keys(DEFAULT_SETTINGS).filter(key => envelope.version !== 1 || !['fontSize', 'alwaysOnTop'].includes(key)).sort();
  if (Object.keys(value).sort().join(',') !== expected.join(',')) {
    throw new Error('设置字段不符合版本契约；原始配置未被覆盖。');
  }
  if (typeof value.opacity !== 'number' || !Number.isFinite(value.opacity)
      || value.opacity < OPACITY_MIN || value.opacity > OPACITY_MAX
      || typeof value.doneDisplayMs !== 'number' || !Number.isInteger(value.doneDisplayMs)
      || value.doneDisplayMs < DONE_DISPLAY_MIN || value.doneDisplayMs > DONE_DISPLAY_MAX
      || typeof value.reducedMotion !== 'boolean' || typeof value.clickThrough !== 'boolean'
      || typeof value.showCommandDetail !== 'boolean' || typeof value.showRepositoryPath !== 'boolean') {
    throw new Error('设置值未通过 schema 校验；原始配置未被覆盖。');
  }
  if (envelope.version === SETTINGS_VERSION && (typeof value.fontSize !== 'number' || !Number.isInteger(value.fontSize)
      || value.fontSize < FONT_SIZE_MIN || value.fontSize > FONT_SIZE_MAX || typeof value.alwaysOnTop !== 'boolean')) {
    throw new Error('字号或置顶设置未通过 schema 校验；原始配置未被覆盖。');
  }
  return {
    opacity: value.opacity, doneDisplayMs: value.doneDisplayMs,
    reducedMotion: value.reducedMotion, clickThrough: value.clickThrough,
    showCommandDetail: value.showCommandDetail, showRepositoryPath: value.showRepositoryPath,
    // Version 1 had no typography/topmost settings; migrate only those new fields.
    fontSize: envelope.version === 1 ? DEFAULT_SETTINGS.fontSize : value.fontSize as number,
    alwaysOnTop: envelope.version === 1 ? DEFAULT_SETTINGS.alwaysOnTop : value.alwaysOnTop as boolean,
  };
}

export function loadSettings(storage: Pick<Storage, 'getItem'>): SettingsLoad {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    return raw === null ? { status: 'new', settings: { ...DEFAULT_SETTINGS } }
      : { status: 'loaded', settings: parseSettings(raw) };
  } catch (error) {
    // This is an explicit, visible recovery state, not a successful fallback read.
    return { status: 'error', settings: { ...DEFAULT_SETTINGS }, error: errorText(error) };
  }
}

export function loadBrowserSettings(): SettingsLoad {
  try {
    return loadSettings(window.localStorage);
  } catch (error) {
    return { status: 'error', settings: { ...DEFAULT_SETTINGS }, error: errorText(error) };
  }
}

export function saveSettings(storage: Pick<Storage, 'setItem'>, settings: HudSettings): void {
  const serialized = JSON.stringify({ version: SETTINGS_VERSION, settings });
  parseSettings(serialized);
  storage.setItem(SETTINGS_KEY, serialized);
}
