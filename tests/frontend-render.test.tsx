import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../src/demo';
import { DEFAULT_SETTINGS, type HudMode, type HudSettings } from '../src/model';
import { Hud, RecentTools } from '../src/Hud';

function markup(mode: HudMode, settings: HudSettings = DEFAULT_SETTINGS, unknown = false) {
  const sessions = createDemoSnapshot(200000).sessions;
  const primary = unknown ? { ...sessions[0], context: undefined, tokens: undefined } : sessions[0];
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
