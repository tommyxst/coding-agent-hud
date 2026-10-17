import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../src/model';
import { createPresentation, createVisualClock, DWELL_MS, IDLE_DEBOUNCE_MS, nextPresentationDelay, pushPresentation, pushThrottle, pushVisual, shouldAnimateTrack, stepParticle, TEXT_THROTTLE_MS, tickPresentation, tickThrottle, tickVisual, TRACK_CENTER, trackTarget } from '../src/visual';

const sample = (detail: string, used: number) => ({ detail, tool: 'Bash', context: { used, limit: 100, estimated: false }, tokens: { input: used, output: 1 } });

describe('visual state smoother', () => {
  it('keeps at most two track changes across eight alternations in 500ms', () => {
    let clock = createVisualClock();
    const seen = [clock.visual];
    for (let index = 0; index < 8; index += 1) {
      const now = index * 60;
      clock = tickVisual(pushVisual(clock, index % 2 === 0 ? 'THINKING' : 'TOOL_RUNNING', 'NONE', now), now);
      if (seen[seen.length - 1] !== clock.visual) seen.push(clock.visual);
    }
    clock = tickVisual(clock, 500);
    if (seen[seen.length - 1] !== clock.visual) seen.push(clock.visual);
    expect(seen.length - 1).toBeLessThanOrEqual(2);
    expect(clock.visual === 'THINKING' || clock.visual === 'TOOL_RUNNING').toBe(true);
  });

  it('bypasses dwell for waiting, error, and turn end', () => {
    let clock = pushVisual(createVisualClock(), 'TOOL_RUNNING', 'NONE', 0);
    expect(clock.dwellUntil).toBe(DWELL_MS);
    for (const attention of ['WAITING_USER', 'ERROR', 'DONE'] as const) {
      clock = pushVisual(clock, 'TOOL_RUNNING', attention, 10);
      expect(clock.visual).toBe('IDLE');
      expect(clock.dwellUntil).toBeNull();
      expect(clock.idleUntil).toBeNull();
      expect(clock.attention).toBe(attention);
    }
  });

  it('holds idle for 650ms and cancels when thinking or tool running returns', () => {
    let clock = pushVisual(createVisualClock(), 'THINKING', 'NONE', 0);
    clock = pushVisual(clock, 'IDLE', 'NONE', 100);
    expect(clock.visual).toBe('THINKING');
    expect(clock.idleUntil).toBe(100 + IDLE_DEBOUNCE_MS);
    expect(tickVisual(clock, 100 + IDLE_DEBOUNCE_MS - 1).visual).toBe('THINKING');
    expect(tickVisual(clock, 100 + IDLE_DEBOUNCE_MS).visual).toBe('IDLE');
    const resumed = pushVisual(clock, 'TOOL_RUNNING', 'NONE', 200);
    expect(resumed.visual).toBe('THINKING');
    expect(resumed.pending).toBe('TOOL_RUNNING');
    expect(resumed.idleUntil).toBeNull();
    expect(tickVisual(resumed, DWELL_MS).visual).toBe('TOOL_RUNNING');
  });

  it('throttles telemetry without waiting for the track dwell', () => {
    let clock = pushThrottle(undefined, sample('one', 1), 0);
    let shown = 1;
    for (let index = 1; index < 8; index += 1) {
      const now = index * 60;
      clock = tickThrottle(pushThrottle(clock, sample(`step-${index}`, index), now), now);
      if (clock.shown.detail === `step-${index}`) shown += 1;
    }
    clock = tickThrottle(clock, 500);
    expect(shown).toBeGreaterThan(2);
    expect(clock.until).toBeGreaterThan(0);
    expect(TEXT_THROTTLE_MS).toBe(80);
  });

  it('does not reset an open dwell when the same snapshot is delivered again', () => {
    const started = pushVisual(createVisualClock(), 'THINKING', 'NONE', 0);
    const repeated = pushVisual(started, 'THINKING', 'NONE', 100);
    expect(repeated.dwellUntil).toBe(started.dwellUntil);
    const session = { id: 's', runtime: { state: 'THINKING' }, attention: { state: 'NONE' } } as AgentSession;
    const first = pushPresentation(createPresentation(), [session], 0);
    const second = pushPresentation(first, [session], 50);
    expect(second.visuals.s.dwellUntil).toBe(first.visuals.s.dwellUntil);
    expect(nextPresentationDelay(second, 50)).toBe(DWELL_MS - 50);
    expect(tickPresentation(second, 50)).toBe(second);
  });
});

describe('track interpolation', () => {
  it('moves from the current x toward the new target without jumping to center', () => {
    const right = trackTarget('tool_running');
    const moved = stepParticle(10, right, 16);
    expect(moved).toBeGreaterThan(10);
    expect(moved).toBeLessThan(right);
    const turned = stepParticle(moved, trackTarget('responding'), 16);
    expect(turned).toBeLessThan(moved);
    expect(turned).not.toBe(TRACK_CENTER);
  });

  it('does not schedule motion for idle, hidden, or disabled tracks', () => {
    expect(shouldAnimateTrack('idle', false, false)).toBe(false);
    expect(shouldAnimateTrack('tool_running', false, true)).toBe(false);
    expect(shouldAnimateTrack('tool_running', true, false)).toBe(false);
    expect(shouldAnimateTrack('thinking', false, false)).toBe(true);
  });
});
