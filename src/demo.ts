import type { AgentSession, Snapshot } from './model';

// All fixture content lives here. This module is imported only by the !isTauri() branch.
export function createDemoSnapshot(now: number): Snapshot {
  return {
    sessions: [
      {
        id: 'demo-claude-wsl',
        environment: { type: 'wsl', distro: 'Ubuntu-24.04' },
        agent: { type: 'claude', name: 'Claude Code', version: 'DEMO' },
        project: { name: 'ai-experience-qa', cwd: '/home/demo/repos/ai-experience-qa', branch: 'feature/hud', dirtyFiles: 5 },
        runtime: { state: 'TOOL_RUNNING', tool: 'Bash', detail: 'npm run test:unit', startedAt: now - 84000, updatedAt: now },
        attention: { state: 'NONE' }, model: { name: 'Claude Sonnet', provider: 'Anthropic' },
        context: { used: 72431, limit: 200000, estimated: true },
        tokens: { input: 72431, output: 6328, cached: 31205 },
      },
      {
        id: 'demo-codex-wsl', environment: { type: 'wsl', distro: 'Ubuntu-24.04' },
        agent: { type: 'codex', name: 'Codex', version: 'DEMO' },
        project: { name: 'wealth-workbench', cwd: '/home/demo/repos/wealth-workbench', branch: 'main', dirtyFiles: 2 },
        runtime: { state: 'THINKING', detail: 'Reviewing the implementation', startedAt: now - 32000, updatedAt: now - 1000 },
        attention: { state: 'NONE' }, model: { name: 'Codex · demo model' },
        context: { used: 134000, limit: 200000, estimated: false },
        tokens: { input: 134000, output: 8400, reasoning: 2200 },
      },
      {
        id: 'demo-claude-win', environment: { type: 'windows' },
        agent: { type: 'claude', name: 'Claude Code', version: 'DEMO' },
        project: { name: 'admin-portal', cwd: 'C:\\Projects\\admin-portal', branch: 'fix/auth', dirtyFiles: 0 },
        runtime: { state: 'IDLE', startedAt: now - 180000, updatedAt: now - 10000 },
        attention: { state: 'NONE' }, context: { used: 62000, limit: 200000, estimated: false },
      },
    ],
    collectors: [
      { agent: 'claude', state: 'unavailable', message: 'DEMO 数据；浏览器不连接 Claude Code collector。' },
      { agent: 'codex', state: 'unavailable', message: 'DEMO 数据；浏览器不连接 Codex collector。' },
    ],
  };
}

export type DemoState = AgentSession['runtime']['state'] | Exclude<AgentSession['attention']['state'], 'NONE'>;
export const DEMO_STATES: DemoState[] = ['STARTING', 'IDLE', 'THINKING', 'TOOL_RUNNING', 'RESPONDING', 'WAITING_USER', 'DONE', 'ERROR'];
export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  STARTING: 'Starting', IDLE: 'Idle', THINKING: 'Thinking', TOOL_RUNNING: 'Tool running', RESPONDING: 'Responding',
  WAITING_USER: 'Waiting user', DONE: 'Done', ERROR: 'Error',
};
export function demoState(snapshot: Snapshot, id: string, state: DemoState, now: number): Snapshot {
  return { ...snapshot, sessions: snapshot.sessions.map(session => {
    if (session.id !== id) return session;
    const attention = state === 'WAITING_USER' || state === 'DONE' || state === 'ERROR';
    return { ...session,
      runtime: { ...session.runtime, state: attention ? 'IDLE' : state,
        tool: state === 'TOOL_RUNNING' ? 'Bash' : undefined,
        detail: state === 'TOOL_RUNNING' ? 'npm run test:unit' : undefined, updatedAt: now },
      attention: { state: attention ? state : 'NONE',
        message: state === 'WAITING_USER' ? 'Bash permission required · demo'
          : state === 'ERROR' ? 'Tool execution failed · demo' : state === 'DONE' ? 'Task completed · demo' : undefined },
    };
  }) };
}
export function demoContext(snapshot: Snapshot, id: string, percent: number | null, estimated: boolean): Snapshot {
  const limit = 200000;
  return { ...snapshot, sessions: snapshot.sessions.map(session => session.id === id
    ? { ...session, context: percent === null ? undefined : { used: limit * percent / 100, limit, estimated } }
    : session) };
}
export function demoUnknownTokens(snapshot: Snapshot, id: string): Snapshot {
  return { ...snapshot, sessions: snapshot.sessions.map(session => session.id === id ? { ...session, tokens: undefined } : session) };
}
export function demoLongContent(snapshot: Snapshot, id: string): Snapshot {
  return { ...snapshot, sessions: snapshot.sessions.map(session => session.id === id
    ? { ...session,
      project: { ...session.project, name: 'very-long-repository-name-for-layout-verification', branch: 'feature/a-very-long-branch-without-breaks', cwd: '/home/demo/a-very-long-workspace/path/with-several-nested-folders/repository' },
      runtime: { ...session.runtime, detail: 'npm run test:unit -- --very-long-argument-for-layout-verification' },
      model: { name: 'A-very-long-model-name-without-spaces-for-layout-verification' } }
    : session) };
}
