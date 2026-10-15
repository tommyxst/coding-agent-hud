import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DEFAULT_SETTINGS, type HudMode, type HudSettings, type Snapshot } from './model';
import { Hud } from './Hud';
import { Icon } from './Icon';
import { CollectorPanel, SettingsPanel } from './Panels';
import { DemoControls } from './DemoControls';
import type * as Demo from './demo';
import { loadBrowserSettings, saveSettings } from './settings';
import { openHudConnection, tauriPort } from './native';
import { errorText, expireDone, resolveMode, needsInteraction, nextDoneDelay, primarySession, rankSessions, reconcileDone, reconcileSelection, selectSession, type DoneRecords, type Selection } from './state';

interface AppProps {
  native: boolean;
  initialSnapshot: Snapshot;
  demo?: typeof Demo;
}
type IssueSource = 'settings' | 'connection' | 'privacy' | 'window' | 'resize' | 'workspace' | 'topmost' | 'drag';
const ISSUE_LABELS: Record<IssueSource, string> = {
  settings: '本地设置', connection: 'Native 连接', privacy: 'Collector 隐私设置',
  window: '窗口交互', resize: '窗口尺寸', workspace: '返回工作区',
  topmost: '窗口置顶', drag: '窗口拖动',
};
type Issues = Partial<Record<IssueSource, string>>;

export function App({ native, initialSnapshot, demo }: AppProps) {
  const [settingsLoad] = useState(loadBrowserSettings);
  const [settings, setSettings] = useState(settingsLoad.settings);
  const [settingsBlocked, setSettingsBlocked] = useState(settingsLoad.status === 'error');
  const [saved, setSaved] = useState(settingsLoad.status === 'loaded');
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selection, setSelection] = useState<Selection>({ selectedId: null, pinnedId: null });
  const [done, setDone] = useState<DoneRecords>(() => reconcileDone({}, initialSnapshot.sessions, Date.now()));
  const doneRef = useRef(done);
  const [automaticId, setAutomaticId] = useState<string | null>(() => rankSessions(initialSnapshot.sessions, done)[0]?.id ?? null);
  const [view, setView] = useState<{ key: string; mode: HudMode } | null>(null);
  const [panel, setPanel] = useState<'settings' | 'collectors' | null>(null);
  const [issues, setIssues] = useState<Issues>(() => settingsLoad.status === 'error'
    ? { settings: `读取失败：${settingsLoad.error} 安全默认仅用于当前窗口，原配置已保留；请明确重置。` } : {});
  const [connection, setConnection] = useState<'loading' | 'live' | 'error'>(native ? 'loading' : 'live');
  const [retry, setRetry] = useState(0);
  const [keyboardInteraction, setKeyboardInteraction] = useState(false);
  const [temporaryInteraction, setTemporaryInteraction] = useState(false);
  const [appliedThrough, setAppliedThrough] = useState(false);
  const [appliedTopmost, setAppliedTopmost] = useState(native ? true : settings.alwaysOnTop);
  const [topmostPending, setTopmostPending] = useState(false);
  const [topmostRequest, setTopmostRequest] = useState(0);
  const [returning, setReturning] = useState(false);
  const [workspaceSuccess, setWorkspaceSuccess] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const currentSettings = useRef(settings);
  currentSettings.current = settings;
  const privacyQueue = useRef<Promise<void>>(Promise.resolve());
  const behaviorQueue = useRef<Promise<void>>(Promise.resolve());
  const topmostQueue = useRef<Promise<void>>(Promise.resolve());

  const report = useCallback((source: IssueSource, error: unknown) => {
    const message = errorText(error);
    setIssues(previous => previous[source] === message ? previous : { ...previous, [source]: message });
  }, []);
  const clearIssue = useCallback((source: IssueSource) => {
    setIssues(previous => { if (!(source in previous)) return previous; const next = { ...previous }; delete next[source]; return next; });
  }, []);
  const acceptSnapshot = useCallback((next: Snapshot) => {
    setSnapshot(next);
    setSelection(previous => reconcileSelection(previous, next.sessions));
    setView(previous => previous && next.sessions.some(session => session.id === previous.key) ? previous : null);
    const records = reconcileDone(doneRef.current, next.sessions, Date.now());
    doneRef.current = records;
    setDone(records);
    setAutomaticId(rankSessions(next.sessions, records)[0]?.id ?? null);
  }, []);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    setConnection('loading');
    setTemporaryInteraction(false);
    const showCommandDetail = currentSettings.current.showCommandDetail;
    const subscription = openHudConnection(tauriPort, acceptSnapshot, setTemporaryInteraction, showCommandDetail);
    subscription.ready.then(() => {
      if (!cancelled) {
        clearIssue('connection');
        setConnection('live');
      }
    }).catch(error => {
      if (!cancelled) { setConnection('error'); report('connection', error); }
    });
    return () => {
      cancelled = true;
      subscription.close().catch(error => {
        report('connection', `事件 listener 清理失败：${errorText(error)}`);
        console.error('HUD event listener cleanup failed', error);
      });
    };
  }, [native, retry, acceptSnapshot, clearIssue, report]);

  useEffect(() => {
    const delay = nextDoneDelay(done, Date.now(), settings.doneDisplayMs);
    if (delay === null) return;
    const timeout = window.setTimeout(() => {
      const records = expireDone(doneRef.current, Date.now(), settings.doneDisplayMs);
      doneRef.current = records;
      setDone(records);
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [done, settings.doneDisplayMs]);

  useEffect(() => {
    const changed = () => { document.documentElement.dataset.hidden = String(document.hidden); };
    changed();
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    const keydown = () => setKeyboardInteraction(true);
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, []);

  // Automatic promotion is driven by a new snapshot, not by a UI expiry timer.
  // Keep a completed primary visible in Compact until another activity event arrives.
  const primary = primarySession(snapshot.sessions, { ...selection, selectedId: selection.selectedId ?? automaticId }, done);
  const primaryKey = primary?.id ?? null;
  const mode: HudMode = primary ? resolveMode(primary, done, view) : 'compact';
  const secondary = rankSessions(snapshot.sessions, done).filter(session => session.id !== primary?.id);
  const hasIssues = Object.keys(issues).length > 0;
  const desiredThrough = settings.clickThrough && connection === 'live' && panel === null && !hasIssues
    && !needsInteraction(mode, snapshot.sessions, done);
  const ghost = native && desiredThrough && appliedThrough && !temporaryInteraction;
  useEffect(() => {
    setView(previous => previous?.key === primaryKey ? previous : null);
  }, [primaryKey]);

  useEffect(() => {
    if (!native || connection !== 'live') return;
    let cancelled = false;
    behaviorQueue.current = behaviorQueue.current.then(() => invoke<void>('set_window_behavior', { clickThrough: desiredThrough }))
      .then(() => { if (!cancelled) setAppliedThrough(desiredThrough); })
      .catch(error => { if (!cancelled) report('window', error); });
    return () => { cancelled = true; };
  }, [native, connection, desiredThrough, retry, clearIssue, report]);
  useEffect(() => {
    if (!native) { setAppliedTopmost(settings.alwaysOnTop); return; }
    if (connection !== 'live') return;
    let cancelled = false;
    setTopmostPending(true);
    topmostQueue.current = topmostQueue.current.then(() => invoke<void>('set_always_on_top', { enabled: settings.alwaysOnTop }))
      .then(() => { setAppliedTopmost(settings.alwaysOnTop); if (!cancelled) clearIssue('topmost'); })
      .catch(error => { if (!cancelled) report('topmost', error); })
      .finally(() => { if (!cancelled) setTopmostPending(false); });
    return () => { cancelled = true; };
  }, [native, connection, settings.alwaysOnTop, topmostRequest, retry, clearIssue, report]);


  useEffect(() => {
    if (!native || connection !== 'live') return;
    let cancelled = false;
    const showCommandDetail = settings.showCommandDetail;
    privacyQueue.current = privacyQueue.current.then(() => invoke<void>('set_privacy', { showCommandDetail }))
      .then(() => { if (!cancelled) clearIssue('privacy'); })
      .catch(error => { if (!cancelled) report('privacy', error); });
    return () => { cancelled = true; };
  }, [native, connection, settings.showCommandDetail, retry, clearIssue, report]);

  useEffect(() => {
    if (!native || connection !== 'live' || wrapper.current === null) return;
    const element = wrapper.current;
    let previousSize = '';
    let frame = 0;
    let cancelled = false;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      const size = `${width}:${height}`;
      if (size === previousSize) return;
      previousSize = size;
      invoke<void>('resize_window', { width, height }).catch(error => { if (!cancelled) report('resize', error); });
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    measure();
    return () => { cancelled = true; observer.disconnect(); cancelAnimationFrame(frame); };
  }, [native, connection, retry, report]);

  const setMode = (next: HudMode) => {
    if (primaryKey !== null) {
      setView({ key: primaryKey, mode: next });
      if (next === 'expanded') setSelection(previous => selectSession(previous, primaryKey));
    }
  };
  const chooseSession = (id: string) => {
    setSelection(previous => selectSession(previous, id));
    setView(null);
    setWorkspaceSuccess(false);
    clearIssue('workspace');
  };
  const chooseAutomatic = () => {
    setSelection({ selectedId: null, pinnedId: null });
    setAutomaticId(rankSessions(snapshot.sessions, done)[0]?.id ?? null);
    setView(null);
  };
  const updateSettings = (next: HudSettings) => {
    setSettings(next);
    try {
      saveSettings(window.localStorage, next);
      setSaved(true);
      setSettingsBlocked(false);
      clearIssue('settings');
    } catch (error) {
      setSaved(false);
      report('settings', `写入失败：${errorText(error)} 本次修改仅在当前窗口生效，未宣称保存成功。`);
    }
  };
  const returnToWorkspace = async () => {
    if (!primary || returning) return;
    setReturning(true);
    setWorkspaceSuccess(false);
    try {
      if (!native) throw new Error('DEMO 无真实终端绑定；未执行任何窗口切换。');
      await invoke<void>('return_to_workspace', { id: primary.id });
      clearIssue('workspace');
      setWorkspaceSuccess(true);
    } catch (error) { report('workspace', error); }
    finally { setReturning(false); }
  };
  const dragWindow = async () => {
    try {
      await getCurrentWindow().startDragging();
      clearIssue('drag');
    } catch (error) { report('drag', error); }
  };
  const toggleTopmost = () => {
    updateSettings({ ...settings, alwaysOnTop: !appliedTopmost });
    setTopmostRequest(previous => previous + 1);
  };
  const reconnect = () => {
    for (const source of ['connection', 'privacy', 'window', 'resize', 'topmost', 'drag'] as const) clearIssue(source);
    setRetry(previous => previous + 1);
  };

  return <main className={native ? 'app-native' : 'app-demo'} data-reduced-motion={settings.reducedMotion} data-keyboard={keyboardInteraction} style={{ '--hud-font-size': `${settings.fontSize}px` } as CSSProperties}
    onKeyDownCapture={event => {
      if (event.key === 'Escape') {
        if (panel !== null) { setPanel(null); requestAnimationFrame(() => document.getElementById('settings-button')?.focus()); }
        else if (mode === 'expanded') setMode('active');
      }
    }} onPointerDownCapture={event => { event.currentTarget.dataset.keyboard = 'false'; setKeyboardInteraction(false); }}>
    <div className={`window-content ${ghost ? 'is-ghost' : ''}`} ref={wrapper} style={{ '--hud-opacity': settings.opacity } as CSSProperties}>
      <div className={`hud-shell ${mode === 'compact' && panel === null && !hasIssues ? 'is-compact' : ''}`} data-mode={mode}>
        {demo ? <div className="demo-mark"><span className="demo-badge mono">DEMO</span><span>示例会话 · 不是实时采集</span></div> : null}
        {primary ? <Hud primary={primary} secondary={secondary} mode={mode} motionDisabled={settings.reducedMotion || keyboardInteraction} settings={settings} done={done} alwaysOnTop={appliedTopmost} topmostPending={topmostPending || (native && connection !== 'live') || settingsBlocked} returning={returning}
          onToggleTopmost={toggleTopmost} onDrag={native ? dragWindow : undefined} onReturn={returnToWorkspace} onMode={setMode} onSelect={chooseSession}/>
          : <section className="empty-card" aria-label="无会话"><span className="empty-symbol"><Icon name="terminal"/></span><div><strong>{connection === 'loading' ? '正在连接本地 Agent…' : connection === 'error' ? '暂时无法读取会话' : '没有活跃的 Agent 会话'}</strong><p>{demo ? 'DEMO 空状态；在下方重置示例会话。' : '启动 Claude Code 或 Codex 后，此处展示真实采集状态。'}</p></div></section>}
        <footer className="hud-utility"><span className="selection-label"><span className={`connection-dot ${connection}`}/>{ghost ? '穿透 · Alt / 托盘交互' : temporaryInteraction ? '临时交互' : selection.selectedId ? '手选主会话' : '自动主会话'}{snapshot.sessions.length > 0 ? <span className="session-count mono">{snapshot.sessions.length} sessions</span> : null}</span><div>{selection.selectedId !== null ? <button className="auto-button" onClick={chooseAutomatic} title="解除手选，恢复优先级排序">Auto</button> : null}<button className={`icon-button ${panel === 'collectors' ? 'is-selected' : ''}`} aria-label="Collector 状态" aria-expanded={panel === 'collectors'} onClick={() => setPanel(panel === 'collectors' ? null : 'collectors')}><Icon name="collectors"/></button><button id="settings-button" className={`icon-button ${panel === 'settings' ? 'is-selected' : ''}`} aria-label="HUD 设置" aria-expanded={panel === 'settings'} onClick={() => setPanel(panel === 'settings' ? null : 'settings')}><Icon name="settings"/></button></div></footer>
        {workspaceSuccess ? <div className="success-notice" role="status"><Icon name="check"/>已请求返回工作区<button className="icon-button" aria-label="关闭返回成功提示" onClick={() => setWorkspaceSuccess(false)}><Icon name="close"/></button></div> : null}
        {Object.entries(issues).map(([source, message]) => <section className="issue-notice" role="alert" key={source}><div><Icon name="error"/><strong>{ISSUE_LABELS[source as IssueSource]}失败</strong>{source !== 'settings' || !settingsBlocked ? <button className="icon-button" aria-label={`关闭${ISSUE_LABELS[source as IssueSource]}错误`} onClick={() => clearIssue(source as IssueSource)}><Icon name="close"/></button> : null}</div><p>{message}</p>{source === 'settings' ? <button className="text-button" onClick={() => updateSettings({ ...DEFAULT_SETTINGS })}>明确重置本地设置</button> : source !== 'workspace' && native ? <button className="text-button" onClick={reconnect} disabled={connection === 'loading'}>重试 native 连接</button> : null}</section>)}
        {panel === 'settings' ? <SettingsPanel settings={settings} disabled={settingsBlocked} native={native} onChange={updateSettings} onReset={() => updateSettings({ ...DEFAULT_SETTINGS })} saved={saved} onClose={() => setPanel(null)}/> : null}
        {panel === 'collectors' ? <CollectorPanel collectors={snapshot.collectors} native={native} connection={connection} onClose={() => setPanel(null)} onRetry={reconnect}/> : null}
      </div>
    </div>
    {demo ? <DemoControls demo={demo} snapshot={snapshot} primaryId={primary?.id} mode={mode} onSnapshot={acceptSnapshot} onMode={setMode}/> : null}
  </main>;
}
