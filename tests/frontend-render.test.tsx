import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../src/demo';
import { DEFAULT_SETTINGS, type HudMode, type HudSettings } from '../src/model';
import { Hud } from '../src/Hud';

function markup(mode: HudMode, settings: HudSettings = DEFAULT_SETTINGS, unknown = false) {
  const sessions = createDemoSnapshot(200000).sessions;
  const primary = unknown ? { ...sessions[0], context: undefined, tokens: undefined } : sessions[0];
  return renderToStaticMarkup(<Hud primary={primary} secondary={sessions.slice(1)} settings={settings} done={{}} mode={mode} pinned={false} returning={false} onPin={() => {}} onReturn={() => {}} onMode={() => {}} onSelect={() => {}}/>);
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
