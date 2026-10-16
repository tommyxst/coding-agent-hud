import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../src/demo';
import { DEFAULT_SETTINGS, type HudMode, type HudSettings, type AgentSession, type CollectorStatus } from '../src/model';
import { Hud, RecentTools } from '../src/Hud';
import { CollectorPanel, EmptyState } from '../src/Panels';

function markup(mode: HudMode, settings: HudSettings = DEFAULT_SETTINGS, unknown = false, ended = false) {
  const sessions = createDemoSnapshot(200000).sessions;
  const primary: AgentSession = { ...sessions[0],
    ...(unknown ? { context: undefined, tokens: undefined } : {}),
    ...(ended ? { attention: { state: 'DONE' as const, message: 'Turn ended' } } : {}),
  };
  return renderToStaticMarkup(<Hud primary={primary} secondary={sessions.slice(1)} settings={settings} done={{}} mode={mode} motionDisabled={false} alwaysOnTop={true} topmostPending={false} returning={false} onToggleTopmost={() => {}} onDrag={() => {}} onReturn={() => {}} onMode={() => {}} onSelect={() => {}}/>);
}
describe('HUD semantic rendering and privacy', () => {
  it.each(['compact', 'active', 'attention', 'expanded'] as const)('renders %s without disclosing hidden commands or paths, including tooltips', mode => {
    const html = markup(mode);
    expect(html).not.toContain('npm run test:unit');
    expect(html).not.toContain('/home/demo/repos');
    expect(html).toContain('ai-experience-qa');
    expect(html).toContain('切换至 wealth-workbench');
  });
  it('only reveals command and workspace after their separate privacy opt-ins', () => {
    expect(markup('expanded', { ...DEFAULT_SETTINGS, showCommandDetail: true })).toContain('npm run test:unit');
    expect(markup('expanded', { ...DEFAULT_SETTINGS, showCommandDetail: true })).not.toContain('/home/demo/repos');
    expect(markup('expanded', { ...DEFAULT_SETTINGS, showRepositoryPath: true })).toContain('/home/demo/repos');
    expect(markup('expanded', { ...DEFAULT_SETTINGS, showRepositoryPath: true })).not.toContain('npm run test:unit');
  });
  it('unknown context has no fictional numeric progress and unknown tokens remain em dashes', () => {
    const html = markup('expanded', DEFAULT_SETTINGS, true);
    expect(html).toContain('context-unknown');
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('未知');
    expect(html).toContain('— / —');
  });
  it('drawer uses a labelled region and semantic description list', () => {
    expect(markup('expanded')).toContain('aria-label="会话详情"');
    expect(markup('expanded')).toContain('<dl');
    expect(markup('active')).not.toContain('<dl');
  });
});

it('shows aggregate recent tool observations separately from the current activity', () => {
  const session = createDemoSnapshot(200000).sessions[0];
  session.runtime.state = 'THINKING';
  session.recentTools = [
    { id: '1', name: 'Read', status: 'RETURNED', observedAt: 200000 },
    { id: '2', name: 'Read', status: 'RETURNED', observedAt: 200001 },
    { id: '3', name: 'Grep', status: 'OBSERVED', observedAt: 200002 },
  ];
  const html = renderToStaticMarkup(<RecentTools session={session}/>);
  expect(html).toContain('Read ×2 · 已返回');
  expect(html).toContain('Grep ×1 · 已观察');
  expect(html).not.toContain('Running');
});

it('keeps a repeated tool group visible when it is the most recent group', () => {
  const session = createDemoSnapshot(200000).sessions[0];
  session.recentTools = ['Read', 'Grep', 'Bash', 'Edit', 'Read'].map((name, index) => ({ id: String(index), name, status: 'RETURNED', observedAt: index }));
  const html = renderToStaticMarkup(<RecentTools session={session}/>);
  expect(html).toContain('Read ×2 · 已返回');
  expect(html).not.toContain('Grep ×1');
});

it.each(['compact', 'active', 'expanded'] as const)('has separate window drag and topmost controls in %s', mode => {
  const html = markup(mode);
  expect(html).toContain('aria-label="拖动窗口"');
  expect(html).toContain('aria-label="取消窗口置顶"');
  expect(html).not.toContain('固定主会话');
});

it('labels placement warnings separately from Agent collectors', () => {
  const html = renderToStaticMarkup(<CollectorPanel collectors={[
    { agent: 'window-placement', state: 'warning', message: '保存的显示器已移除' },
    { agent: 'codex-live', state: 'watching', message: '只读连接' },
  ]} native={true} connection="live" onClose={() => {}} onRetry={() => {}}/>);
  expect(html).toContain('<strong>窗口位置</strong>');
  expect(html).toContain('collector-warning mono">Warning');
  expect(html).toContain('保存的显示器已移除');
  expect(html).toContain('<strong>Codex 实时</strong>');
});

it.each([false, true])('renders turn end without task completion claims with details=%s', showCommandDetail => {
  const html = markup('attention', { ...DEFAULT_SETTINGS, showCommandDetail }, false, true);
  expect(html).toContain('TURN ENDED');
  expect(html).toContain('本轮已结束');
  expect(html).not.toMatch(/任务已完成|TASK COMPLETED|Task completed/);
});

describe('evidence-based empty state', () => {
  const render = (connection: 'loading' | 'live' | 'error', collectors: CollectorStatus[] = [], native = true) =>
    renderToStaticMarkup(<EmptyState native={native} connection={connection} collectors={collectors}/>);
  it('distinguishes HUD connection from Agent discovery', () => {
    expect(render('loading')).toContain('正在连接本地 HUD');
    expect(render('error')).toContain('无法读取采集状态');
    expect(render('error')).not.toContain('没有活跃');
    expect(render('live')).toContain('等待采集状态');
  });
  it('does not infer Hook installation from an empty snapshot', () => {
    const html = render('live', [{ agent: 'claude', state: 'waiting', message: 'future wording' }]);
    expect(html).toContain('等待 Hook 验证');
    expect(html).not.toMatch(/未安装|已接入/);
  });
  it.each(['error', 'unavailable'] as const)('reports partial collector %s without claiming no agents exist', state => {
    const html = render('live', [{ agent: 'codex-live', state, message: 'failure' }, { agent: 'claude', state: 'watching', message: 'verified' }]);
    expect(html).toContain('部分采集入口不可用');
    expect(html).not.toContain('没有活跃');
  });
  it('does not treat a window-position error as an Agent failure', () => {
    const html = render('live', [{ agent: 'claude', state: 'watching', message: 'verified' }, { agent: 'window-placement', state: 'error', message: 'bad file' }]);
    expect(html).toContain('未发现可确认的活跃会话');
    expect(html).not.toContain('采集入口不可用');
  });
  it('keeps connecting and demo separate from successful discovery', () => {
    expect(render('live', [{ agent: 'codex-live', state: 'connecting', message: 'connecting' }])).toContain('正在连接采集入口');
    expect(render('live', [], false)).toContain('DEMO 空状态');
  });
  it('shows known limits without claiming the user runs an unsupported mode', () => {
    const html = renderToStaticMarkup(<CollectorPanel collectors={[
      { agent: 'claude', state: 'waiting', message: '等待首个已验证 Hook 事件' },
      { agent: 'codex-live', state: 'connecting', message: '连接中' },
    ]} native={true} connection="live" onClose={() => {}} onRetry={() => {}}/>);
    expect(html).toContain('等待验证');
    expect(html).toContain('原生 claude.exe');
    expect(html).toContain('--no-daemon');
    expect(html).toContain('不代表 Agent 已接入');
    expect(html).not.toContain('当前使用了');
  });
});
