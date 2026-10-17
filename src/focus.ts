import type { AgentSession } from './model';

export const IDLE_FOCUS_MS = 3000;

export interface FocusMemory {
  activeId: string | null;
  pinnedId: string | null;
  idleSince: number | null;
  order: string[];
  alerts: Record<string, 'WAITING_USER' | 'ERROR' | null>;
}

export function emptyFocus(): FocusMemory {
  return { activeId: null, pinnedId: null, idleSince: null, order: [], alerts: {} };
}

export function orderedSessions(order: readonly string[], sessions: AgentSession[]): AgentSession[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const kept = order.flatMap(id => {
    const session = byId.get(id);
    return session ? [session] : [];
  });
  const known = new Set(kept.map(session => session.id));
  const fresh = sessions.filter(session => !known.has(session.id))
    .sort((a, b) => a.runtime.startedAt - b.runtime.startedAt || a.id.localeCompare(b.id));
  return [...kept, ...fresh];
}

export function agentTabLabel(session: AgentSession, ordered: AgentSession[]): string {
  const prefix = session.agent.type === 'claude' ? 'CC' : 'CX';
  let index = 1;
  for (const item of ordered) {
    if (item.id === session.id) break;
    if (item.agent.type === session.agent.type) index += 1;
  }
  return `${prefix}${index}`;
}

function alertOf(session: AgentSession): 'WAITING_USER' | 'ERROR' | null {
  return session.attention.state === 'WAITING_USER' || session.attention.state === 'ERROR' ? session.attention.state : null;
}

function working(session: AgentSession): boolean {
  return session.attention.state === 'NONE'
    && (session.runtime.state === 'THINKING' || session.runtime.state === 'TOOL_RUNNING' || session.runtime.state === 'RESPONDING');
}

function idleWatch(session: AgentSession): boolean {
  return session.runtime.state === 'IDLE' && session.attention.state === 'NONE';
}

export function sameFocus(a: FocusMemory, b: FocusMemory): boolean {
  if (a.activeId !== b.activeId || a.pinnedId !== b.pinnedId || a.idleSince !== b.idleSince) return false;
  if (a.order.length !== b.order.length || a.order.some((id, index) => id !== b.order[index])) return false;
  const keys = new Set([...Object.keys(a.alerts), ...Object.keys(b.alerts)]);
  for (const key of keys) if (a.alerts[key] !== b.alerts[key]) return false;
  return true;
}

export function reconcileFocus(memory: FocusMemory, sessions: AgentSession[], now: number): FocusMemory {
  const ordered = orderedSessions(memory.order, sessions);
  const order = ordered.map(session => session.id);
  const byId = new Map(ordered.map(session => [session.id, session]));
  const alive = (id: string | null) => id !== null && byId.has(id);
  const pinnedId = alive(memory.pinnedId) ? memory.pinnedId : null;
  const hadActive = memory.activeId !== null;
  const activeRemoved = hadActive && !alive(memory.activeId);
  let activeId: string | null = pinnedId ?? (alive(memory.activeId) ? memory.activeId : ordered[0]?.id ?? null);
  const alerts: FocusMemory['alerts'] = {};
  for (const session of ordered) alerts[session.id] = alertOf(session);
  const established = hadActive || Object.keys(memory.alerts).length > 0;
  if (pinnedId === null && established && !activeRemoved && activeId !== null) {
    const fresh = ordered.filter(session => {
      const next = alertOf(session);
      return session.id !== activeId && next !== null && memory.alerts[session.id] !== next;
    });
    if (fresh.length > 0) {
      fresh.sort((a, b) => (a.attention.state === 'ERROR' ? 0 : 1) - (b.attention.state === 'ERROR' ? 0 : 1)
        || a.runtime.startedAt - b.runtime.startedAt || a.id.localeCompare(b.id));
      activeId = fresh[0].id;
    } else {
      const active = byId.get(activeId);
      const idleSince = active && idleWatch(active)
        ? (memory.activeId === active.id && memory.idleSince !== null ? memory.idleSince : now)
        : null;
      if (active && idleSince !== null && now - idleSince >= IDLE_FOCUS_MS) {
        const background = ordered.filter(session => session.id !== active.id && working(session));
        background.sort((a, b) => b.runtime.updatedAt - a.runtime.updatedAt || a.runtime.startedAt - b.runtime.startedAt || a.id.localeCompare(b.id));
        if (background.length > 0) activeId = background[0].id;
      }
    }
  }
  const active = activeId === null ? undefined : byId.get(activeId);
  const idleSince = active && idleWatch(active)
    ? (memory.activeId === active.id && memory.idleSince !== null && !activeRemoved ? memory.idleSince : now)
    : null;
  return { activeId, pinnedId, idleSince, order, alerts };
}

export function focusSession(memory: FocusMemory, id: string, sessions: AgentSession[], now: number): FocusMemory {
  return reconcileFocus({
    ...memory,
    activeId: id,
    pinnedId: memory.pinnedId === null ? null : id,
    idleSince: memory.activeId === id ? memory.idleSince : null,
  }, sessions, now);
}

export function toggleSessionPin(memory: FocusMemory, id: string, sessions: AgentSession[], now: number): FocusMemory {
  return reconcileFocus({
    ...memory,
    activeId: id,
    pinnedId: memory.pinnedId === id ? null : id,
    idleSince: memory.activeId === id ? memory.idleSince : null,
  }, sessions, now);
}
