export type ActivityState = 'STARTING' | 'IDLE' | 'THINKING' | 'TOOL_RUNNING' | 'RESPONDING';
export type AttentionState = 'NONE' | 'WAITING_USER' | 'DONE' | 'ERROR';
export type HudMode = 'compact' | 'active' | 'attention' | 'expanded';

export interface AgentSession {
  id: string;
  environment: { type: 'windows' | 'wsl'; distro?: string };
  agent: { type: 'claude' | 'codex'; name: string; version?: string };
  project: { cwd: string; root?: string; name: string; branch?: string; dirtyFiles?: number };
  runtime: { state: ActivityState; tool?: string; detail?: string; startedAt: number; updatedAt: number };
  attention: { state: AttentionState; message?: string };
  model?: { name: string; provider?: string };
  context?: { used: number; limit?: number; estimated: boolean };
  tokens?: { input?: number; output?: number; reasoning?: number; cached?: number };
  workspace?: { terminalPid?: number; terminalType?: string; agentPid?: number };
  recentTools?: { id: string; name: string; status: 'OBSERVED' | 'RETURNED' | 'FAILED'; observedAt: number }[];
}

export interface CollectorStatus {
  agent: 'claude' | 'codex' | 'codex-live' | 'window-placement';
  state: 'waiting' | 'connecting' | 'watching' | 'unavailable' | 'warning' | 'error';
  message: string;
}

export interface Snapshot {
  sessions: AgentSession[];
  collectors: CollectorStatus[];
}

export interface HudSettings {
  opacity: number;
  fontSize: number;
  alwaysOnTop: boolean;
  reducedMotion: boolean;
  clickThrough: boolean;
  showCommandDetail: boolean;
  showRepositoryPath: boolean;
  doneDisplayMs: number;
}

export const DEFAULT_SETTINGS: HudSettings = {
  opacity: 0.88,
  fontSize: 15,
  alwaysOnTop: true,
  reducedMotion: false,
  clickThrough: true,
  showCommandDetail: false,
  showRepositoryPath: false,
  doneDisplayMs: 7000,
};
