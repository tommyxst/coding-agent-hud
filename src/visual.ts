import type { ActivityState, AgentSession, AttentionState } from './model';

export const DWELL_MS = 380;
export const IDLE_DEBOUNCE_MS = 650;
export const TEXT_THROTTLE_MS = 80;

export type VisualActivity = ActivityState;

export interface VisualClock {
  visual: VisualActivity;
  pending: VisualActivity | null;
  dwellUntil: number | null;
  idleUntil: number | null;
  attention: AttentionState;
}

export interface TelemetrySample {
  tool?: string;
  detail?: string;
  tokens?: AgentSession['tokens'];
  context?: AgentSession['context'];
}

export interface ThrottleClock<T> {
  shown: T;
  pending: T | null;
  until: number | null;
}

export interface Presentation {
  visuals: Record<string, VisualClock>;
  texts: Record<string, ThrottleClock<TelemetrySample>>;
}

const WORK: ReadonlySet<VisualActivity> = new Set(['THINKING', 'TOOL_RUNNING', 'RESPONDING']);

export function createVisualClock(): VisualClock {
  return { visual: 'IDLE', pending: null, dwellUntil: null, idleUntil: null, attention: 'NONE' };
}

export function createPresentation(): Presentation {
  return { visuals: {}, texts: {} };
}

function bypass(attention: AttentionState): boolean {
  return attention === 'WAITING_USER' || attention === 'ERROR' || attention === 'DONE';
}

function cleared(attention: AttentionState): VisualClock {
  return { visual: 'IDLE', pending: null, dwellUntil: null, idleUntil: null, attention };
}

export function pushVisual(clock: VisualClock, activity: VisualActivity, attention: AttentionState, now: number): VisualClock {
  if (bypass(attention)) return cleared(attention);
  if (activity === 'IDLE') {
    if (clock.visual === 'IDLE') return { visual: 'IDLE', pending: null, dwellUntil: null, idleUntil: null, attention };
    return { ...clock, pending: null, idleUntil: clock.idleUntil ?? now + IDLE_DEBOUNCE_MS, attention };
  }
  if (activity === 'STARTING') return { visual: 'STARTING', pending: null, dwellUntil: null, idleUntil: null, attention };
  const open = WORK.has(clock.visual) && clock.dwellUntil !== null && now < clock.dwellUntil;
  if (!open) {
    if (clock.visual === activity) {
      return { visual: activity, pending: null, dwellUntil: null, idleUntil: null, attention };
    }
    return { visual: activity, pending: null, dwellUntil: now + DWELL_MS, idleUntil: null, attention };
  }
  return { ...clock, pending: activity === clock.visual ? null : activity, idleUntil: null, attention };
}

export function tickVisual(clock: VisualClock, now: number): VisualClock {
  if (bypass(clock.attention)) return clock;
  if (clock.idleUntil !== null && now >= clock.idleUntil) return cleared(clock.attention);
  if (clock.dwellUntil !== null && now >= clock.dwellUntil) {
    if (clock.pending !== null && clock.pending !== clock.visual) {
      return { visual: clock.pending, pending: null, dwellUntil: now + DWELL_MS, idleUntil: null, attention: clock.attention };
    }
    return { ...clock, pending: null, dwellUntil: null };
  }
  return clock;
}

export function telemetrySample(session: AgentSession): TelemetrySample {
  return { tool: session.runtime.tool, detail: session.runtime.detail, tokens: session.tokens, context: session.context };
}

export function sameTelemetry(a: TelemetrySample, b: TelemetrySample): boolean {
  return a.tool === b.tool && a.detail === b.detail
    && a.tokens?.input === b.tokens?.input && a.tokens?.output === b.tokens?.output
    && a.tokens?.reasoning === b.tokens?.reasoning && a.tokens?.cached === b.tokens?.cached
    && a.context?.used === b.context?.used && a.context?.limit === b.context?.limit
    && a.context?.estimated === b.context?.estimated;
}

export function pushThrottle(clock: ThrottleClock<TelemetrySample> | undefined, value: TelemetrySample, now: number): ThrottleClock<TelemetrySample> {
  if (clock && sameTelemetry(clock.shown, value) && (clock.pending === null || sameTelemetry(clock.pending, value))) {
    return clock.pending === null ? clock : { ...clock, pending: null };
  }
  if (!clock || clock.until === null || now >= clock.until) return { shown: value, pending: null, until: now + TEXT_THROTTLE_MS };
  if (clock.pending && sameTelemetry(clock.pending, value)) return clock;
  return { ...clock, pending: value };
}

export function tickThrottle(clock: ThrottleClock<TelemetrySample>, now: number): ThrottleClock<TelemetrySample> {
  if (clock.pending === null || clock.until === null || now < clock.until) return clock;
  return { shown: clock.pending, pending: null, until: now + TEXT_THROTTLE_MS };
}

export function pushPresentation(previous: Presentation, sessions: AgentSession[], now: number): Presentation {
  const visuals: Record<string, VisualClock> = {};
  const texts: Record<string, ThrottleClock<TelemetrySample>> = {};
  for (const session of sessions) {
    const pushed = pushVisual(previous.visuals[session.id] ?? createVisualClock(), session.runtime.state, session.attention.state, now);
    visuals[session.id] = tickVisual(pushed, now);
    texts[session.id] = tickThrottle(pushThrottle(previous.texts[session.id], telemetrySample(session), now), now);
  }
  return { visuals, texts };
}

export function tickPresentation(previous: Presentation, now: number): Presentation {
  let changed = false;
  const visuals: Record<string, VisualClock> = {};
  const texts: Record<string, ThrottleClock<TelemetrySample>> = {};
  for (const [id, clock] of Object.entries(previous.visuals)) {
    const next = tickVisual(clock, now);
    visuals[id] = next;
    if (next !== clock) changed = true;
  }
  for (const [id, clock] of Object.entries(previous.texts)) {
    const next = tickThrottle(clock, now);
    texts[id] = next;
    if (next !== clock) changed = true;
  }
  return changed ? { visuals, texts } : previous;
}

export function nextPresentationDelay(presentation: Presentation, now: number): number | null {
  let nearest: number | null = null;
  const consider = (time: number | null) => {
    if (time === null) return;
    const delay = Math.max(0, time - now);
    nearest = nearest === null ? delay : Math.min(nearest, delay);
  };
  for (const clock of Object.values(presentation.visuals)) {
    consider(clock.dwellUntil);
    consider(clock.idleUntil);
  }
  for (const clock of Object.values(presentation.texts)) {
    if (clock.pending !== null) consider(clock.until);
  }
  return nearest;
}

export const TRACK_CENTER = 50;
export const TRACK_LIMIT = 46;

export function trackTarget(state: 'thinking' | 'tool_running' | 'responding' | 'idle' | 'starting'): number {
  if (state === 'tool_running') return TRACK_CENTER + TRACK_LIMIT;
  if (state === 'responding') return TRACK_CENTER - TRACK_LIMIT;
  return TRACK_CENTER;
}

export function stepParticle(x: number, target: number, dt: number): number {
  const next = x + (target - x) * (1 - Math.exp(-dt / 140));
  return Math.abs(next - target) < 0.05 ? target : next;
}

export function shouldAnimateTrack(state: string, disabled: boolean, hidden: boolean): boolean {
  return !disabled && !hidden && (state === 'thinking' || state === 'tool_running' || state === 'responding');
}
