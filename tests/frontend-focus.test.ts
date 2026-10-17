import { describe, expect, it } from 'vitest';
import { agentTabLabel, emptyFocus, focusSession, IDLE_FOCUS_MS, orderedSessions, reconcileFocus, toggleSessionPin } from '../src/focus';
import type { ActivityState, AgentSession, AttentionState } from '../src/model';

function session(id: string, agent: 'claude' | 'codex', startedAt: number, state: ActivityState = 'IDLE', attention: AttentionState = 'NONE', updatedAt = startedAt): AgentSession {
  return {
    id,
    environment: { type: 'windows' },
    agent: { type: agent, name: agent },
    project: { cwd: 'C:/work', name: id, branch: 'main', dirtyFiles: 0 },
    runtime: { state, startedAt, updatedAt },
    attention: { state: attention },
  };
}

describe('side-tab order and sticky focus', () => {
  const claudeA = session('a', 'claude', 10, 'IDLE', 'NONE', 500);
  const codex = session('b', 'codex', 20, 'TOOL_RUNNING', 'NONE', 400);
  const claudeB = session('c', 'claude', 30, 'THINKING', 'NONE', 300);


  it('keeps the first discovery order and appends a later-seen session', () => {
    const ordered = orderedSessions([], [claudeB, claudeA, codex]);
    expect(ordered.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(ordered.map(item => agentTabLabel(item, ordered))).toEqual(['CC1', 'CX1', 'CC2']);
    const seen = reconcileFocus(emptyFocus(), [claudeA, codex], 1000);
    const late = session('z', 'claude', 1, 'THINKING', 'NONE', 900);
    const next = reconcileFocus(seen, [late, codex, { ...claudeA, runtime: { ...claudeA.runtime, updatedAt: 1 } }], 1100);
    expect(next.order).toEqual(['a', 'b', 'z']);
  });

  it('appends a new session without taking the card', () => {
    const seen = reconcileFocus(emptyFocus(), [claudeA], 1000);
    const next = reconcileFocus(seen, [claudeA, codex], 1100);
    expect(next.activeId).toBe('a');
  });

  it('switches only when a background alert begins, and not on the same alert again', () => {
    const seen = reconcileFocus(emptyFocus(), [claudeA, codex], 1000);
    const waiting = session('b', 'codex', 20, 'IDLE', 'WAITING_USER', 1200);
    const switched = reconcileFocus(seen, [claudeA, waiting], 1200);
    expect(switched.activeId).toBe('b');
    const back = focusSession(switched, 'a', [claudeA, waiting], 1300);
    expect(back.activeId).toBe('a');
    expect(reconcileFocus(back, [claudeA, waiting], 1400).activeId).toBe('a');
  });

  it('keeps a pinned session in place', () => {
    const seen = reconcileFocus(emptyFocus(), [claudeA, codex], 1000);
    const pinned = toggleSessionPin(seen, 'a', [claudeA, codex], 1000);
    const waiting = session('b', 'codex', 20, 'IDLE', 'ERROR', 2000);
    expect(reconcileFocus(pinned, [claudeA, waiting], 2000).activeId).toBe('a');
    expect(reconcileFocus(pinned, [{ ...claudeA, runtime: { ...claudeA.runtime, state: 'IDLE' } }, codex], 1000 + IDLE_FOCUS_MS).activeId).toBe('a');
  });

  it('follows a background worker only after the current session has been idle for 3 seconds', () => {
    const seen = reconcileFocus(emptyFocus(), [claudeA, codex], 1000);
    expect(seen.idleSince).toBe(1000);
    expect(reconcileFocus(seen, [claudeA, codex], 1000 + IDLE_FOCUS_MS - 1).activeId).toBe('a');
    expect(reconcileFocus(seen, [claudeA, codex], 1000 + IDLE_FOCUS_MS).activeId).toBe('b');
  });

  it('selects the earliest remaining tab when the active session disappears', () => {
    const seen = focusSession(reconcileFocus(emptyFocus(), [claudeA, codex, claudeB], 1000), 'c', [claudeA, codex, claudeB], 1000);
    expect(reconcileFocus(seen, [codex, claudeA], 2000).activeId).toBe('a');
    expect(reconcileFocus(seen, [], 2000).activeId).toBeNull();
  });
});
