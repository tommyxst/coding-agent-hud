import type { AgentSession, AttentionState, HudMode } from './model';

export interface Selection {
  selectedId: string | null;
  pinnedId: string | null;
}

export interface DoneRecord {
  seenAt: number;
  expired: boolean;
}
export type DoneRecords = Record<string, DoneRecord>;

const ATTENTION_PRIORITY: Record<AttentionState, number> = {
  WAITING_USER: 8, ERROR: 7, DONE: 6, NONE: 0,
};
const ACTIVITY_PRIORITY: Record<AgentSession['runtime']['state'], number> = {
  TOOL_RUNNING: 5, RESPONDING: 4, THINKING: 3, STARTING: 2, IDLE: 1,
};

export function displayedAttention(session: AgentSession, done: DoneRecords): AttentionState {
  return session.attention.state === 'DONE' && done[session.id]?.expired
    ? 'NONE' : session.attention.state;
}

export function rankSessions(sessions: AgentSession[], done: DoneRecords): AgentSession[] {
  return [...sessions].sort((a, b) => {
    const priority = (session: AgentSession) => {
      const attention = displayedAttention(session, done);
      // A completed session must not retain a stale TOOL_RUNNING activity priority.
      return attention !== 'NONE' ? ATTENTION_PRIORITY[attention]
        : session.attention.state === 'DONE' ? ACTIVITY_PRIORITY.IDLE
          : ACTIVITY_PRIORITY[session.runtime.state];
    };
    return priority(b) - priority(a)
      || b.runtime.updatedAt - a.runtime.updatedAt
      || a.id.localeCompare(b.id);
  });
}

export function reconcileSelection(selection: Selection, sessions: AgentSession[]): Selection {
  const exists = (id: string | null) => id !== null && sessions.some(session => session.id === id);
  return {
    selectedId: exists(selection.selectedId) ? selection.selectedId : null,
    pinnedId: exists(selection.pinnedId) ? selection.pinnedId : null,
  };
}

export function primarySession(sessions: AgentSession[], selection: Selection, done: DoneRecords): AgentSession | undefined {
  const valid = reconcileSelection(selection, sessions);
  return sessions.find(session => session.id === valid.pinnedId)
    ?? sessions.find(session => session.id === valid.selectedId)
    ?? rankSessions(sessions, done)[0];
}

export function selectSession(selection: Selection, id: string): Selection {
  // An explicit click switches the primary, including an existing pin.
  return { selectedId: id, pinnedId: selection.pinnedId === null ? null : id };
}

export function togglePin(selection: Selection, id: string): Selection {
  return { selectedId: id, pinnedId: selection.pinnedId === id ? null : id };
}

export function reconcileDone(previous: DoneRecords, sessions: AgentSession[], now: number): DoneRecords {
  const next: DoneRecords = {};
  for (const session of sessions) {
    if (session.attention.state === 'DONE') {
      next[session.id] = previous[session.id] ?? { seenAt: now, expired: false };
    }
  }
  return next;
}

export function expireDone(records: DoneRecords, now: number, doneDisplayMs: number): DoneRecords {
  return Object.fromEntries(Object.entries(records).map(([id, record]) => [id,
    record.expired || now - record.seenAt < doneDisplayMs
      ? record : { ...record, expired: true },
  ]));
}

export function nextDoneDelay(records: DoneRecords, now: number, doneDisplayMs: number): number | null {
  const pending = Object.values(records).filter(record => !record.expired);
  return pending.length === 0 ? null
    : Math.max(0, Math.min(...pending.map(record => record.seenAt + doneDisplayMs - now)));
}

export interface ViewChoice { key: string; mode: HudMode }

export function resolveMode(session: AgentSession, done: DoneRecords, view: ViewChoice | null): HudMode {
  const requested = view?.key === session.id ? view.mode : null;
  if (requested === 'expanded') return 'expanded';
  if (displayedAttention(session, done) !== 'NONE') return 'attention';
  return requested ?? automaticMode(session, done);
}

export function automaticMode(session: AgentSession, done: DoneRecords): HudMode {
  if (displayedAttention(session, done) !== 'NONE') return 'attention';
  if (session.attention.state === 'DONE' || session.runtime.state === 'IDLE') return 'compact';
  return 'active';
}

export function needsInteraction(mode: HudMode, sessions: AgentSession[], done: DoneRecords): boolean {
  return mode === 'attention' || mode === 'expanded'
    || sessions.some(session => {
      const attention = displayedAttention(session, done);
      return attention === 'WAITING_USER' || attention === 'ERROR';
    });
}

export const CONTEXT_WARNING = 70;
export const CONTEXT_CRITICAL = 90;
export type ContextLevel = 'normal' | 'warning' | 'critical' | 'unknown';
export interface ContextReading {
  percent: number | null;
  level: ContextLevel;
  estimated: boolean;
  used: number | undefined;
  limit: number | undefined;
}

export function contextReading(context: AgentSession['context']): ContextReading {
  if (context === undefined || context.limit === undefined || context.limit <= 0) {
    return { percent: null, level: 'unknown', estimated: context?.estimated === true,
      used: context?.used, limit: context?.limit };
  }
  const ratio = context.used / context.limit * 100;
  return { percent: Math.floor(ratio),
    level: ratio >= CONTEXT_CRITICAL ? 'critical' : ratio >= CONTEXT_WARNING ? 'warning' : 'normal',
    estimated: context.estimated, used: context.used, limit: context.limit };
}

const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const exactNumber = new Intl.NumberFormat('en-US');
export function formatCount(value: number | undefined, exact = false): string {
  return value === undefined ? '—' : exact ? exactNumber.format(value) : compactNumber.format(value).toLowerCase();
}
export function formatContextPercent(reading: ContextReading): string {
  return reading.percent === null ? '—' : `${reading.estimated ? '≈' : ''}${reading.percent}%`;
}
export function durationAtSnapshot(session: AgentSession): string {
  const seconds = Math.max(0, Math.floor((session.runtime.updatedAt - session.runtime.startedAt) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export const ACTIVITY_LABELS: Record<AgentSession['runtime']['state'], string> = {
  STARTING: 'Starting', IDLE: 'Idle', THINKING: 'Thinking', TOOL_RUNNING: 'Running', RESPONDING: 'Responding',
};
export const ATTENTION_LABELS: Record<Exclude<AttentionState, 'NONE'>, string> = {
  WAITING_USER: 'Waiting', ERROR: 'Error', DONE: 'Ended',
};
export function stateLabel(session: AgentSession, done: DoneRecords): string {
  const attention = displayedAttention(session, done);
  if (attention !== 'NONE') return ATTENTION_LABELS[attention];
  return session.attention.state === 'DONE' ? 'Idle' : ACTIVITY_LABELS[session.runtime.state];
}
export function safeActionSummary(session: AgentSession, showDetail: boolean): string {
  if (session.attention.state === 'DONE') return '本轮已结束';
  if (showDetail && session.runtime.detail) return session.runtime.detail;
  switch (session.runtime.state) {
    case 'TOOL_RUNNING': return '正在执行工具 · 具体内容已隐藏';
    case 'THINKING': return '正在推理';
    case 'RESPONDING': return '正在生成回复';
    case 'STARTING': return '正在连接会话';
    case 'IDLE': return '等待下一项任务';
  }
}

export function errorText(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${Array.from(error.errors, errorText).join('; ')}`;
  if (error instanceof Error) return error.message;
  return typeof error === 'object' ? JSON.stringify(error) : String(error);
}
