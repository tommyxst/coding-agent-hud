import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../src/demo';
import { DEFAULT_SETTINGS } from '../src/model';
import type { AgentSession } from '../src/model';
import { automaticMode, contextReading, displayedAttention, expireDone, formatContextPercent, formatCount, resolveMode, needsInteraction, nextDoneDelay, primarySession, rankSessions, reconcileDone, reconcileSelection, selectSession, togglePin, safeActionSummary, stateLabel } from '../src/state';

const auto = { selectedId: null, pinnedId: null };
const fixture = () => createDemoSnapshot(200000).sessions;
function attention(session: AgentSession, state: AgentSession['attention']['state']): AgentSession {
  return { ...session, attention: { state } };
}

describe('primary selection and 1+N ranking', () => {
  it('ranks Waiting > Error > Done > tool > response > thinking > idle, without mutating input', () => {
    const base = fixture()[0];
    const sessions = [
      { ...base, id: 'idle', runtime: { ...base.runtime, state: 'IDLE' as const } },
      { ...base, id: 'thinking', runtime: { ...base.runtime, state: 'THINKING' as const } },
      { ...base, id: 'response', runtime: { ...base.runtime, state: 'RESPONDING' as const } },
      { ...base, id: 'tool' },
      attention({ ...base, id: 'done' }, 'DONE'),
      attention({ ...base, id: 'error' }, 'ERROR'),
      attention({ ...base, id: 'waiting' }, 'WAITING_USER'),
    ];
    expect(rankSessions(sessions, {}).map(session => session.id)).toEqual(['waiting', 'error', 'done', 'tool', 'response', 'thinking', 'idle']);
    expect(sessions[0].id).toBe('idle');
  });
  it('uses recency, then ID as a stable tie breaker', () => {
    const base = fixture()[0];
    const sessions = [{ ...base, id: 'z' }, { ...base, id: 'a' }, { ...base, id: 'new', runtime: { ...base.runtime, updatedAt: base.runtime.updatedAt + 1 } }];
    expect(rankSessions(sessions, {}).map(session => session.id)).toEqual(['new', 'a', 'z']);
  });
  it('auto-promotes a high-priority event when no session was explicitly selected', () => {
    const sessions = fixture();
    sessions[1] = attention(sessions[1], 'WAITING_USER');
    expect(primarySession(sessions, auto, {})?.id).toBe(sessions[1].id);
  });
  it('background Waiting cannot steal an explicitly selected primary', () => {
    const sessions = fixture();
    sessions[1] = attention(sessions[1], 'WAITING_USER');
    expect(primarySession(sessions, { selectedId: sessions[0].id, pinnedId: null }, {})?.id).toBe(sessions[0].id);
  });
  it('a pin outranks attention and an older selected ID', () => {
    const sessions = fixture();
    sessions[1] = attention(sessions[1], 'ERROR');
    expect(primarySession(sessions, { selectedId: sessions[1].id, pinnedId: sessions[2].id }, {})?.id).toBe(sessions[2].id);
  });
  it('explicit secondary selection transfers an existing pin, but does not invent a pin', () => {
    expect(selectSession(auto, 's2')).toEqual({ selectedId: 's2', pinnedId: null });
    expect(selectSession({ selectedId: 's1', pinnedId: 's1' }, 's2')).toEqual({ selectedId: 's2', pinnedId: 's2' });
  });
  it('unpin preserves the explicitly observed session until Auto is chosen', () => {
    const pinned = togglePin(auto, 's1');
    expect(pinned).toEqual({ selectedId: 's1', pinnedId: 's1' });
    expect(togglePin(pinned, 's1')).toEqual({ selectedId: 's1', pinnedId: null });
  });
  it('clears disappeared selection/pin and returns undefined for no sessions', () => {
    expect(reconcileSelection({ selectedId: 'gone', pinnedId: 'gone' }, fixture())).toEqual(auto);
    expect(primarySession([], auto, {})).toBeUndefined();
  });
});

describe('Done lifecycle and mode transitions', () => {
  it('returns to compact at exactly settings.doneDisplayMs', () => {
    const session = attention(fixture()[0], 'DONE');
    const records = reconcileDone({}, [session], 1000);
    const before = expireDone(records, 1000 + DEFAULT_SETTINGS.doneDisplayMs - 1, DEFAULT_SETTINGS.doneDisplayMs);
    const after = expireDone(records, 1000 + DEFAULT_SETTINGS.doneDisplayMs, DEFAULT_SETTINGS.doneDisplayMs);
    expect(automaticMode(session, before)).toBe('attention');
    expect(automaticMode(session, after)).toBe('compact');
    expect(displayedAttention(session, after)).toBe('NONE');
    expect(resolveMode(session, after, null)).toBe('compact');
  });
  it('does not restart Done time for new snapshots with a changed runtime timestamp', () => {
    const session = attention(fixture()[0], 'DONE');
    const previous = reconcileDone({}, [session], 1000);
    const updated = { ...session, runtime: { ...session.runtime, updatedAt: 5000 } };
    expect(reconcileDone(previous, [updated], 5000)[session.id].seenAt).toBe(1000);
  });
  it('a new Done after an activity transition starts a new deadline', () => {
    const session = fixture()[0];
    const first = reconcileDone({}, [attention(session, 'DONE')], 1000);
    const reset = reconcileDone(first, [session], 2000);
    expect(reset).toEqual({});
    expect(reconcileDone(reset, [attention(session, 'DONE')], 3000)[session.id].seenAt).toBe(3000);
  });
  it('only schedules the earliest pending deadline and stops when none remain', () => {
    const records = { a: { seenAt: 1000, expired: false }, b: { seenAt: 2000, expired: false } };
    expect(nextDoneDelay(records, 5000, 7000)).toBe(3000);
    expect(nextDoneDelay(expireDone(records, 9000, 7000), 9000, 7000)).toBeNull();
    expect(nextDoneDelay({}, 1000, 7000)).toBeNull();
  });
  it('expired Done does not retain stale running priority', () => {
    const sessions = fixture();
    sessions[0] = attention(sessions[0], 'DONE');
    expect(rankSessions(sessions, { [sessions[0].id]: { seenAt: 0, expired: true } })[0].id).toBe(sessions[1].id);
  });
  it('waiting/error remain interactive even if the user requests compact or they are secondary', () => {
    const session = fixture()[0];
    expect(needsInteraction('compact', [attention(session, 'WAITING_USER')], {})).toBe(true);
    expect(needsInteraction('active', [attention(session, 'ERROR')], {})).toBe(true);
    expect(needsInteraction('expanded', [session], {})).toBe(true);
    expect(needsInteraction('active', [session], {})).toBe(false);
  });
  it('idle is compact and active work uses active', () => {
    const sessions = fixture();
    expect(automaticMode(sessions[0], {})).toBe('active');
    expect(automaticMode(sessions[2], {})).toBe('compact');
  });
  it('keeps the card active while visual work outlives a raw idle gap', () => {
    const session = fixture()[2];
    session.runtime.state = 'IDLE';
    expect(automaticMode(session, {}, 'THINKING')).toBe('active');
    expect(resolveMode(session, {}, null, 'TOOL_RUNNING')).toBe('active');
    expect(automaticMode(session, {}, 'IDLE')).toBe('compact');
  });
});

describe('Context and unknown telemetry', () => {
  it.each([[69, 'normal'], [70, 'warning'], [89, 'warning'], [90, 'critical'], [100, 'critical']] as const)('uses the exact %s percent threshold', (percent, level) => {
    expect(contextReading({ used: percent * 1000, limit: 100000, estimated: false }).level).toBe(level);
  });
  it('does not round a below-threshold value up into a warning', () => {
    const reading = contextReading({ used: 69999, limit: 100000, estimated: false });
    expect(reading.level).toBe('normal');
    expect(reading.percent).toBe(69);
  });
  it('unknown or missing limits never imply 0 percent or a fictional model capacity', () => {
    expect(contextReading(undefined).percent).toBeNull();
    expect(contextReading({ used: 42000, estimated: true }).percent).toBeNull();
    expect(contextReading({ used: 0, limit: 0, estimated: false }).percent).toBeNull();
    expect(formatContextPercent(contextReading(undefined))).toBe('—');
  });
  it('marks estimates and preserves zero versus unknown token counts', () => {
    expect(formatContextPercent(contextReading({ used: 70000, limit: 100000, estimated: true }))).toBe('≈70%');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(72431, true)).toBe('72,431');
  });
});

describe('manual view is scoped to the session, not its changing activity', () => {
  it.each(['STARTING', 'IDLE', 'THINKING', 'TOOL_RUNNING', 'RESPONDING'] as const)('keeps details open through %s', state => {
    const session = fixture()[0];
    session.runtime.state = state;
    expect(resolveMode(session, {}, { key: session.id, mode: 'expanded' })).toBe('expanded');
  });
  it.each(['WAITING_USER', 'ERROR', 'DONE'] as const)('does not hide %s behind a manual compact choice', state => {
    const session = attention(fixture()[0], state);
    expect(resolveMode(session, {}, { key: session.id, mode: 'compact' })).toBe('attention');
    expect(resolveMode(session, {}, { key: session.id, mode: 'expanded' })).toBe('expanded');
  });
  it('does not apply another session’s manual view', () => {
    expect(resolveMode(fixture()[0], {}, { key: 'other', mode: 'expanded' })).toBe('active');
  });
});

describe('turn end semantics and snapshot reconciliation', () => {
  it.each([false, true])('turn end does not claim task acceptance with details=%s', showDetail => {
    const session = attention(fixture()[0], 'DONE');
    expect(safeActionSummary(session, showDetail)).toBe('本轮已结束');
    expect(stateLabel(session, {})).toBe('Ended');
  });
  it('duplicate and late background snapshots preserve manual choice without replaying an expired end', () => {
    const sessions = fixture();
    sessions[1] = attention(sessions[1], 'DONE');
    const selection = selectSession(auto, sessions[0].id);
    const done = expireDone(reconcileDone({}, sessions, 1000), 8000, 7000);
    for (const updatedAt of [sessions[1].runtime.updatedAt, 1]) {
      sessions[1] = { ...sessions[1], runtime: { ...sessions[1].runtime, updatedAt } };
      const next = reconcileDone(done, sessions, 9000);
      expect(next).toEqual(done);
      expect(nextDoneDelay(next, 9000, 7000)).toBeNull();
      expect(primarySession(sessions, reconcileSelection(selection, sessions), next)?.id).toBe(sessions[0].id);
    }
    expect(reconcileSelection(selection, [])).toEqual(auto);
    expect(reconcileDone(done, [], 9000)).toEqual({});
    expect(primarySession([], auto, {})).toBeUndefined();
  });
});
