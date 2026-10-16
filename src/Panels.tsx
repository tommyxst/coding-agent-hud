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
          <span>Done 展示时间</span>
          <input type="number" min={DONE_DISPLAY_MIN / 1000} max={DONE_DISPLAY_MAX / 1000} step="1"
            value={settings.doneDisplayMs / 1000} aria-label="Done 展示秒数"
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
};
const collectorNames: Record<CollectorStatus['agent'], string> = {
  claude: 'Claude Code', codex: 'Codex', 'codex-live': 'Codex 实时', 'window-placement': '窗口位置',
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
            : '来自本地 native 的最新采集状态。'
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
