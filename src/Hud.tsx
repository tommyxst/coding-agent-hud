import type { CSSProperties } from 'react';
import type { AgentSession, HudMode, HudSettings } from './model';
import { Icon } from './Icon';
import { PipelineTrack, type MotionState } from './PipelineTrack';
import { contextReading, displayedAttention, durationAtSnapshot, formatContextPercent, formatCount, safeActionSummary, stateLabel, type DoneRecords } from './state';

function Environment({ session }: { session: AgentSession }) {
  return <span className="environment mono" title={session.environment.type === 'wsl' ? session.environment.distro : 'Windows'}>{session.environment.type === 'wsl' ? 'WSL' : 'WIN'}</span>;
}
export function ContextRing({ session }: { session: AgentSession }) {
  const reading = contextReading(session.context);
  const percent = reading.percent === null ? 0 : Math.min(100, reading.percent);
  return <span className={`context-mini context-${reading.level} mono`} title={reading.percent === null ? 'Context 未知，未提供有效上限' : `${reading.estimated ? '估算 · ' : ''}Context ${reading.percent}%`}>
    <span>{formatContextPercent(reading)}</span>
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle className="ring-base" cx="10" cy="10" r="7" fill="none" strokeWidth="2"/><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${percent * 0.44} 44`} transform="rotate(-90 10 10)"/></svg>
  </span>;
}

function ContextMeter({ session }: { session: AgentSession }) {
  const reading = contextReading(session.context);
  return <div className={`context-meter context-${reading.level}`}>
    <div className="context-heading mono"><span className="muted">Context</span><span>{reading.estimated && reading.used !== undefined ? '≈' : ''}{formatCount(reading.used)} <span className="muted">/ {formatCount(reading.limit)}</span> <strong>{reading.percent === null ? '未知' : formatContextPercent(reading)}</strong></span></div>
    <div className="meter-track" role={reading.percent === null ? undefined : 'progressbar'} aria-label={reading.percent === null ? 'Context 水位未知' : 'Context 使用率'} aria-valuemin={reading.percent === null ? undefined : 0} aria-valuemax={reading.percent === null ? undefined : 100} aria-valuenow={reading.percent === null ? undefined : Math.min(100, reading.percent)} aria-valuetext={reading.percent === null ? undefined : formatContextPercent(reading)}>
      {reading.percent === null ? <span className="meter-unknown"/> : <span className="meter-fill" style={{ transform: `scaleX(${Math.min(100, reading.percent) / 100})` }}/>}
    </div>
  </div>;
}

export function RecentTools({ session }: { session: AgentSession }) {
  if (!session.recentTools?.length) return null;
  const groups = new Map<string, { name: string; status: string; count: number; observedAt: number }>();
  const labels = { OBSERVED: '已观察', RETURNED: '已返回', FAILED: '失败' };
  for (const tool of session.recentTools) {
    const key = `${tool.name}:${tool.status}`;
    const previous = groups.get(key);
    groups.set(key, { name: tool.name, status: labels[tool.status], count: (previous?.count ?? 0) + 1, observedAt: Math.max(previous?.observedAt ?? tool.observedAt, tool.observedAt) });
  }
  return <span className="recent-tools" aria-label="近期工具观察"><span className="muted">近期工具 · </span>{[...groups.values()].sort((a, b) => a.observedAt - b.observedAt).slice(-3).map(tool => <span className="recent-tool" key={`${tool.name}:${tool.status}`}>{tool.name} ×{tool.count} · {tool.status}</span>)}</span>;
}

function Pipeline({ session, settings, done, motionDisabled }: { session: AgentSession; settings: HudSettings; done: DoneRecords; motionDisabled: boolean }) {
  const attention = displayedAttention(session, done);
  const moving = attention === 'NONE' && session.attention.state !== 'DONE';
  const state = (moving ? session.runtime.state.toLowerCase() : 'idle') as MotionState;
  const target = session.runtime.state === 'TOOL_RUNNING' && session.attention.state === 'NONE'
    ? session.runtime.tool ?? 'Tool' : session.runtime.state === 'IDLE' || session.attention.state !== 'NONE' ? 'Standby' : 'Model';
  return <span className={`pipeline pipeline-${state}`}>
    <span className="pipeline-row"><span className="pipeline-node mono"><span className="brand-dot"/>{session.agent.type === 'claude' ? 'CC' : 'CX'}</span><PipelineTrack key={session.id} state={state} disabled={motionDisabled}/><span className="pipeline-node pipeline-target mono" title={target}>{target}</span></span>
    <span className="action-row"><span className="action-summary" title={safeActionSummary(session, settings.showCommandDetail)}><span className="muted">› </span>{safeActionSummary(session, settings.showCommandDetail)}</span><span className="activity-label mono">{stateLabel(session, done)}</span></span>
    <RecentTools session={session}/>
  </span>;
}

function DetailDrawer({ session, settings }: { session: AgentSession; settings: HudSettings }) {
  const rows = [
    ['Model', session.model?.name ?? '未知 · 数据源未提供'],
    ['Input / Output', `${formatCount(session.tokens?.input, true)} / ${formatCount(session.tokens?.output, true)}`],
    ['Reasoning', formatCount(session.tokens?.reasoning, true)],
    ['Cache read', formatCount(session.tokens?.cached, true)],
    ['Git', `${session.project.branch ?? '分支未知'} · ${session.project.dirtyFiles === undefined ? '变更数未知' : `${session.project.dirtyFiles} files`}`],
    ['Workspace', settings.showRepositoryPath ? session.project.cwd : '完整路径已隐藏'],
    ['Environment', session.environment.type === 'wsl' ? `WSL · ${session.environment.distro ?? '发行版未知'}` : 'Windows'],
    ['Duration', `${durationAtSnapshot(session)} · 截至最近采集`],
  ];
  return <section id="session-details" className="detail-drawer" aria-label="会话详情"><dl className="detail-grid">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mono">{value}</dd></div>)}</dl><p className="detail-note">— 表示未知；缓存比例与 Git diff 不在当前数据契约中，不推算。</p></section>;
}

const attentionTitles = { WAITING_USER: 'WAITING FOR YOU', ERROR: 'SESSION ERROR', DONE: 'TURN ENDED', NONE: 'ATTENTION VIEW' };
function AttentionBanner({ session, settings, done, onReturn, returning }: { session: AgentSession; settings: HudSettings; done: DoneRecords; onReturn: () => void; returning: boolean }) {
  const attention = displayedAttention(session, done);
  const summary = settings.showCommandDetail && session.attention.message
    ? session.attention.message : attention === 'WAITING_USER' ? '需要确认；请返回工作区继续。'
      : attention === 'ERROR' ? '会话遇到错误；请返回工作区查看。'
        : attention === 'DONE' ? '本轮已结束；结果请回工作区确认。' : '当前没有需要处理的 Attention 事件。';
  return <div className={`attention-banner attention-${attention.toLowerCase()}`} role="status"><div className="attention-title mono"><Icon name={attention === 'DONE' ? 'check' : attention === 'ERROR' ? 'error' : 'terminal'}/>{attentionTitles[attention]}</div><p>{summary}</p>{attention === 'WAITING_USER' || attention === 'ERROR' ? <button className="return-action" onClick={onReturn} disabled={returning}>{returning ? '正在返回…' : '返回工作区'}<Icon name="arrow"/></button> : null}</div>;
}

function DragHandle({ onDrag }: { onDrag?: () => void }) {
  return <button className="icon-button drag-handle" aria-label="拖动窗口" title={onDrag ? '拖动窗口 · 穿透时按住 Alt 或用托盘恢复交互' : 'DEMO 不移动桌面窗口'} disabled={!onDrag}
    onPointerDown={event => { if (event.button === 0) { event.preventDefault(); onDrag?.(); } }}><span aria-hidden="true">⠿</span></button>;
}

interface HudProps {
  primary: AgentSession;
  secondary: AgentSession[];
  settings: HudSettings;
  done: DoneRecords;
  mode: HudMode;
  motionDisabled: boolean;
  alwaysOnTop: boolean;
  topmostPending: boolean;
  returning: boolean;
  onToggleTopmost: () => void;
  onDrag?: () => void;
  onReturn: () => void;
  onMode: (mode: HudMode) => void;
  onSelect: (id: string) => void;
}

export function Hud({ primary, secondary, settings, done, mode, motionDisabled, alwaysOnTop, topmostPending, returning, onToggleTopmost, onDrag, onReturn, onMode, onSelect }: HudProps) {
  const attention = displayedAttention(primary, done);
  const compact = mode === 'compact';
  return <section className={`hud-card agent-${primary.agent.type} attention-${attention.toLowerCase()}`} aria-label="Agent HUD" data-primary={primary.id}>
    {compact ? <div className="compact-head"><DragHandle onDrag={onDrag}/><button className="compact-summary" onClick={() => onMode('active')} aria-label={`展开 ${primary.project.name} 会话`}><span className="brand-dot"/><span className="compact-agent mono">{primary.agent.type === 'claude' ? 'CC' : 'CX'}<span className="compact-env">·{primary.environment.type === 'wsl' ? 'WSL' : 'Win'}</span></span><span className="compact-project">{primary.project.name}</span><span className="compact-status mono">{stateLabel(primary, done)}</span><ContextRing session={primary}/></button><button className={`icon-button ${alwaysOnTop ? 'is-selected' : ''}`} aria-label={alwaysOnTop ? '取消窗口置顶' : '窗口置顶'} title={alwaysOnTop ? '取消窗口置顶' : '窗口置顶'} aria-pressed={alwaysOnTop} disabled={topmostPending} onClick={onToggleTopmost}><Icon name="pin"/></button></div> : <>
      <header className="hud-header"><DragHandle onDrag={onDrag}/><span className="agent-identity"><span className="brand-dot"/><span className="agent-name">{primary.agent.name}</span><Environment session={primary}/></span><div className="header-actions"><button className={`icon-button ${alwaysOnTop ? 'is-selected' : ''}`} aria-label={alwaysOnTop ? '取消窗口置顶' : '窗口置顶'} title={alwaysOnTop ? '取消窗口置顶' : '窗口置顶'} aria-pressed={alwaysOnTop} disabled={topmostPending} onClick={onToggleTopmost}><Icon name="pin"/></button><button className="icon-button" aria-label="返回工作区" title="返回工作区" onClick={onReturn} disabled={returning}><Icon name="arrow"/></button><button className="icon-button" aria-label="收起为 Compact" onClick={() => onMode('compact')}><Icon name="minus"/></button></div></header>
      <div className="primary-content"><button className="primary-summary" onClick={() => onMode(mode === 'expanded' ? 'active' : 'expanded')} aria-expanded={mode === 'expanded'} aria-controls="session-details" aria-label={`${mode === 'expanded' ? '收起' : '展开'} ${primary.project.name} 详情`}><span className="project-row"><span className="project-name">{primary.project.name}</span><span className="git-badge mono" title={`${primary.project.branch ?? '分支未知'} · ${primary.project.dirtyFiles === undefined ? '变更数未知' : `${primary.project.dirtyFiles} files`}`}><Icon name="branch"/><span>{primary.project.branch ?? '—'}</span>{primary.project.dirtyFiles === undefined ? null : <span className="dirty-count">{primary.project.dirtyFiles === 0 ? <Icon name="check"/> : `+${primary.project.dirtyFiles}`}</span>}</span></span><Pipeline session={primary} settings={settings} done={done} motionDisabled={motionDisabled}/></button>
      {mode === 'attention' || (mode === 'expanded' && attention !== 'NONE') ? <AttentionBanner session={primary} settings={settings} done={done} onReturn={onReturn} returning={returning}/> : null}
      <ContextMeter session={primary}/><div className="telemetry-footer mono"><span>In <b>{formatCount(primary.tokens?.input)}</b><span className="separator">·</span>Out <b>{formatCount(primary.tokens?.output)}</b></span><span className="duration" title="时长截至最近采集；前端不循环计时"><Icon name="clock"/>{durationAtSnapshot(primary)}</span></div></div>
      <button className="detail-toggle" onClick={() => onMode(mode === 'expanded' ? 'active' : 'expanded')} aria-expanded={mode === 'expanded'} aria-controls="session-details"><span>{mode === 'expanded' ? '收起详情' : '会话详情'}<span className="detail-hint">{settings.showCommandDetail ? '命令可见' : '隐私保护'}</span></span><Icon name="chevron" className={mode === 'expanded' ? 'rotated' : ''}/></button>
      {mode === 'expanded' ? <DetailDrawer session={primary} settings={settings}/> : null}
    </>}
    {secondary.length > 0 ? <div className="secondary-stack" aria-label="其他会话">{secondary.map((session, index) => <button key={session.id} className={`secondary-row agent-${session.agent.type} attention-${displayedAttention(session, done).toLowerCase()}`} style={{ '--row-delay': `${Math.min(index, 6) * 30}ms` } as CSSProperties} onClick={() => onSelect(session.id)} aria-label={`切换至 ${session.project.name}，${stateLabel(session, done)}`}><span className="brand-dot"/><span className="secondary-agent mono">{session.agent.type === 'claude' ? 'CC' : 'CX'}<span>·{session.environment.type === 'wsl' ? 'WSL' : 'Win'}</span></span><span className="secondary-project">{session.project.name}</span><span className="secondary-status mono">{stateLabel(session, done)}</span><ContextRing session={session}/></button>)}</div> : null}
  </section>;
}
