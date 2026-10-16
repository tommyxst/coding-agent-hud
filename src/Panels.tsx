import type { CollectorStatus, HudSettings } from './model';
import { Icon } from './Icon';
import { DONE_DISPLAY_MAX, DONE_DISPLAY_MIN, FONT_SIZE_MAX, FONT_SIZE_MIN, OPACITY_MAX, OPACITY_MIN } from './settings';

interface SettingsProps {
  settings: HudSettings;
  disabled: boolean;
  native: boolean;
  onChange: (settings: HudSettings) => void;
  onReset: () => void;
  onClose: () => void;
  saved: boolean;
}

export function SettingsPanel({ settings, disabled, native, onChange, onReset, onClose, saved }: SettingsProps) {
  const toggle = (key: 'reducedMotion' | 'clickThrough' | 'showCommandDetail' | 'showRepositoryPath', label: string, hint?: string) => (
    <label className="setting-toggle">
      <span>{label}{hint ? <small>{hint}</small> : null}</span>
      <input type="checkbox" checked={settings[key]} disabled={disabled}
        onChange={event => onChange({ ...settings, [key]: event.target.checked })}/>
    </label>
  );
  return (
    <section className="utility-panel" aria-label="HUD 设置">
      <header className="panel-heading">
        <h2>HUD 设置</h2>
        <button className="icon-button" aria-label="关闭设置" onClick={onClose}><Icon name="close"/></button>
      </header>
      <p className="panel-description">仅保存在本机；不持久化会话、路径或命令。</p>
      <fieldset disabled={disabled}>
        <legend className="group-label">隐私</legend>
        {toggle('showCommandDetail', '显示具体命令', '同时允许 collector 提供命令详情。')}
        {toggle('showRepositoryPath', '显示仓库完整路径')}
        <div className="setting-divider"/>
        <span className="group-label">窗口与动画</span>
        {toggle('clickThrough', '鼠标穿透', native
          ? '按住 Alt 或通过托盘恢复交互；Waiting / Error 可直接交互。'
          : '只在桌面 native 生效；DEMO 始终可操作。')}
        {toggle('reducedMotion', '减少动态效果', '系统减少动态效果设置也始终生效。')}
        <label className="setting-slider">
          <span>界面字号 <output className="mono">{settings.fontSize} px</output></span>
          <input type="range" aria-label="界面字号" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} step="1"
            value={settings.fontSize} onChange={event => onChange({ ...settings, fontSize: Number(event.target.value) })}/>
        </label>
        <label className="setting-slider">
          <span>背景不透明度 <output className="mono">{Math.round(settings.opacity * 100)}%</output></span>
          <input type="range" min={OPACITY_MIN * 100} max={OPACITY_MAX * 100} step="1"
            value={Math.round(settings.opacity * 100)}
            onChange={event => onChange({ ...settings, opacity: Number(event.target.value) / 100 })}/>
        </label>
        <label className="setting-select">
          <span>本轮结束提示时间</span>
          <input type="number" min={DONE_DISPLAY_MIN / 1000} max={DONE_DISPLAY_MAX / 1000} step="1"
            value={settings.doneDisplayMs / 1000} aria-label="本轮结束提示秒数"
            onChange={event => {
              if (event.target.validity.valid && event.target.value !== '') {
                onChange({ ...settings, doneDisplayMs: Number(event.target.value) * 1000 });
              }
            }}/>
          <span className="muted">秒</span>
        </label>
      </fieldset>
      <footer className="settings-footer">
        <span role="status">{disabled ? '配置未读取，需明确重置' : saved ? '已保存至本机' : '当前设置尚未保存'}</span>
        <button className="text-button" onClick={onReset}>重置为默认</button>
      </footer>
    </section>
  );
}

const collectorLabels: Record<CollectorStatus['state'], string> = {
  watching: 'Watching', unavailable: 'Unavailable', warning: 'Warning', error: 'Error',
  waiting: '等待验证', connecting: '连接中',
};
const collectorNames: Record<CollectorStatus['agent'], string> = {
  claude: 'Claude Code', codex: 'Codex', 'codex-live': 'Codex 实时', 'window-placement': '窗口位置',
};
const collectorLimits: Partial<Record<CollectorStatus['agent'], string>> = {
  claude: '支持范围：原生 claude.exe；npm / Node 包装版与 WSL 尚未支持。',
  codex: 'rollout 仅覆盖已保存事件；历史文件须验证活跃持有进程。',
  'codex-live': '仅覆盖同一 CODEX_HOME 的已有共享 daemon；embedded / --no-daemon 不在实时连接范围内。',
};
interface CollectorProps {
  collectors: CollectorStatus[];
  native: boolean;
  connection: 'loading' | 'live' | 'error';
  onClose: () => void;
  onRetry: () => void;
}
export function CollectorPanel({ collectors, native, connection, onClose, onRetry }: CollectorProps) {
  return (
    <section className="utility-panel" aria-label="Collector 状态">
      <header className="panel-heading">
        <h2>Collector 状态</h2>
        <button className="icon-button" aria-label="关闭 Collector 状态" onClick={onClose}><Icon name="close"/></button>
      </header>
      <p className="panel-description">{native
        ? connection === 'loading' ? '正在注册事件并读取快照…'
          : connection === 'error' ? 'Native 连接失败；下方保留最后收到的 collector 状态。'
            : 'HUD 已连接，不代表 Agent 已接入；以下按各采集入口的实际证据显示。'
        : 'DEMO · 浏览器没有连接任何 collector。'}</p>
      {collectors.length === 0 ? <p className="collector-empty">尚未收到 collector 状态。</p> : (
        <ul className="collector-list">
          {collectors.map(collector => (
            <li key={collector.agent}>
              <div className="collector-title">
                <span className={`brand-dot agent-${collector.agent}`}/>
                <strong>{collectorNames[collector.agent]}</strong>
                <span className={`collector-state collector-${collector.state} mono`}>{collectorLabels[collector.state]}</span>
              </div>
              <p>{collector.message}</p>
              {native && collectorLimits[collector.agent] ? <p>{collectorLimits[collector.agent]}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {native ? <button className="text-button" onClick={onRetry} disabled={connection === 'loading'}>
        {connection === 'loading' ? '正在连接…' : '重新连接 native'}
      </button> : null}
    </section>
  );
}

export function EmptyState({ native, connection, collectors }: Pick<CollectorProps, 'native' | 'connection' | 'collectors'>) {
  const agents = collectors.filter(collector => collector.agent !== 'window-placement');
  let title: string;
  let message: string;
  if (!native) {
    title = '没有演示会话';
    message = 'DEMO 空状态；在下方重置示例会话。';
  } else if (connection === 'loading') {
    title = '正在连接本地 HUD…';
    message = '正在注册事件并读取快照；尚不能判断 Agent 状态。';
  } else if (connection === 'error') {
    title = '无法读取采集状态';
    message = 'HUD 连接失败，不代表 Agent 已退出；请查看连接错误后重试。';
  } else if (agents.length === 0) {
    title = '等待采集状态';
    message = 'HUD 已连接，尚未收到 Agent 采集入口状态。';
  } else if (agents.some(collector => collector.state === 'error' || collector.state === 'unavailable')) {
    title = '部分采集入口不可用';
    message = '尚无可确认的活跃会话；请查看 Collector 状态中的原因与支持范围。';
  } else if (agents.some(collector => collector.agent === 'claude' && collector.state === 'waiting')) {
    title = '等待 Hook 验证';
    message = '尚未收到已验证的 Claude Hook；请检查接入并启动新会话。';
  } else if (agents.some(collector => collector.state === 'connecting')) {
    title = '正在连接采集入口';
    message = 'HUD 已连接；采集连接结果请查看 Collector 状态。';
  } else {
    title = '未发现可确认的活跃会话';
    message = '仅显示已验证来源的会话；采集能力与限制见 Collector 状态。';
  }
  return <section className="empty-card" aria-label="无会话"><span className="empty-symbol"><Icon name="terminal"/></span><div><strong>{title}</strong><p>{message}</p></div></section>;
}
