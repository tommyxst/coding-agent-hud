// Browser acceptance for the side-tab dock. Synthetic sessions only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [modulePath, outputDirectory] = process.argv.slice(2);
assert.ok(modulePath && outputDirectory && path.isAbsolute(modulePath) && path.isAbsolute(outputDirectory), 'Usage: node scripts/verify-side-dock.cjs <absolute-playwright-module> <absolute-output-directory>');
const { chromium } = require(modulePath);

function session(id, agent, startedAt, state, attention, detail, used) {
  return {
    id,
    environment: { type: id.endsWith('wsl') ? 'wsl' : 'windows', distro: id.endsWith('wsl') ? 'Ubuntu' : undefined },
    agent: { type: agent, name: agent === 'claude' ? 'Claude Code' : 'Codex' },
    project: { cwd: 'C:/work/' + id, name: id, branch: 'main', dirtyFiles: 1 },
    runtime: { state, tool: state === 'TOOL_RUNNING' ? 'Bash' : undefined, detail, startedAt, updatedAt: startedAt },
    attention: { state: attention },
    context: { used, limit: 100, estimated: false },
    tokens: { input: used, output: 2 },
  };
}

let browser;
const checks = [];
async function main() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:1420');
  await page.locator('.side-dock').waitFor();
  const four = [
    session('cc-a', 'claude', 10, 'TOOL_RUNNING', 'NONE', 'read a', 20),
    session('cx-a', 'codex', 20, 'THINKING', 'NONE', 'think a', 40),
    session('cc-b-wsl', 'claude', 30, 'IDLE', 'NONE', 'idle b', 60),
    session('cx-b', 'codex', 40, 'RESPONDING', 'NONE', 'reply b', 80),
  ];
  await page.evaluate(sessions => window.__hudDemo.push({ sessions, collectors: [] }), four);
  await page.locator('.side-code', { hasText: 'CX2' }).waitFor();
  const layout = await page.evaluate(() => {
    const dock = document.querySelector('.side-dock').getBoundingClientRect();
    const card = document.querySelector('.hud-card').getBoundingClientRect();
    const tab = document.querySelector('.side-tab').getBoundingClientRect();
    const line = document.querySelector('.side-context').getBoundingClientRect();
    return {
      dock: dock.width,
      card: card.width,
      tab: tab.height,
      line: line.height,
      labels: [...document.querySelectorAll('.side-code')].map(node => node.textContent),
      secondary: document.querySelectorAll('.secondary-stack').length,
      header: document.querySelector('.hud-header').textContent,
    };
  });
  assert.equal(layout.dock, 48);
  assert.equal(layout.card, 348);
  assert.ok(Math.abs(layout.tab - 26) <= 1, `tab height ${layout.tab}`);
  assert.ok(Math.abs(layout.line - 1.5) <= 0.6, `context line ${layout.line}`);
  assert.deepEqual(layout.labels, ['CC1', 'CX1', 'CC2', 'CX2']);
  assert.equal(layout.secondary, 0);
  assert.match(layout.header, /cc-a/);
  assert.match(layout.header, /Win/);
  assert.match(layout.header, /main/);
  assert.match(layout.header, /\+1/);
  checks.push('four tabs, fixed size, no stacked list');

  const beforeHeight = await page.locator('.hud-card').evaluate(node => node.getBoundingClientRect().height);
  await page.evaluate(() => {
    const sessions = window.__hudDemo.read().sessions.map((item, index) => ({
      ...item,
      runtime: { ...item.runtime, state: index % 2 ? 'TOOL_RUNNING' : 'THINKING', updatedAt: 1000 - index, detail: 'burst ' + index },
    }));
    window.__hudDemo.push({ sessions: [sessions[3], sessions[0], sessions[2], sessions[1]], collectors: [] });
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const shuffled = await page.evaluate(() => ({
    height: document.querySelector('.hud-card').getBoundingClientRect().height,
    labels: [...document.querySelectorAll('.side-code')].map(node => node.textContent),
  }));
  assert.deepEqual(shuffled.labels, ['CC1', 'CX1', 'CC2', 'CX2']);
  assert.equal(beforeHeight, shuffled.height);
  checks.push('updates do not reorder tabs or grow the card');

  await page.evaluate(() => {
    const sessions = window.__hudDemo.read().sessions.map(item => item.id === 'cx-b'
      ? { ...item, attention: { state: 'WAITING_USER' }, runtime: { ...item.runtime, state: 'IDLE' } }
      : item);
    window.__hudDemo.push({ sessions, collectors: [] });
  });
  await page.locator('.side-tab.attention-waiting_user').waitFor();
  assert.equal(await page.locator('.hud-card').getAttribute('data-primary'), 'cx-b');
  checks.push('new background waiting takes an unpinned card');

  await page.getByRole('button', { name: '固定当前会话', exact: true }).first().click();
  await page.evaluate(() => {
    const sessions = window.__hudDemo.read().sessions.map(item => item.id === 'cc-b-wsl'
      ? { ...item, attention: { state: 'ERROR' }, runtime: { ...item.runtime, state: 'IDLE' } }
      : item);
    window.__hudDemo.push({ sessions, collectors: [] });
  });
  await page.locator('.side-tab.attention-error').waitFor();
  assert.equal(await page.locator('.hud-card').getAttribute('data-primary'), 'cx-b');
  assert.equal(await page.locator('.side-tab.attention-error').count(), 1);
  checks.push('pin blocks a later background error');

  await page.evaluate(() => {
    const sessions = window.__hudDemo.read().sessions.filter(item => item.id !== 'cx-b');
    window.__hudDemo.push({ sessions, collectors: [] });
  });
  await page.waitForFunction(() => document.querySelector('.hud-card').dataset.primary === 'cc-a');
  assert.deepEqual(await page.locator('.side-code').allTextContents(), ['CC1', 'CX1', 'CC2']);
  checks.push('closing the active session selects the earliest remaining tab');

  await page.getByRole('button', { name: '切换至 cx-a', exact: false }).click();
  await page.waitForFunction(() => document.querySelector('.hud-card').dataset.primary === 'cx-a');
  const active = await page.locator('.side-tab.is-active').evaluate(element => ({
    label: element.querySelector('.side-code').textContent,
    margin: getComputedStyle(element).marginRight,
  }));
  assert.equal(active.label, 'CX1');
  assert.equal(active.margin, '-1px');
  assert.match(await page.locator('.project-name').textContent(), /cx-a/);
  checks.push('click switches the card and joins the active tab');

  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.hud-shell').dataset.mode === 'compact');
  assert.equal(await page.locator('.pipeline-track').count(), 0);
  await page.getByRole('button', { name: '切换至 cc-a', exact: false }).click();
  await page.waitForFunction(() => document.querySelector('.hud-shell').dataset.mode === 'active' && document.querySelector('.hud-card').dataset.primary === 'cc-a');
  checks.push('compact click expands the selected session');
  await page.getByRole('button', { name: 'HUD 设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '显示具体命令' }).check();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();

  const burst = await page.evaluate(async () => {
    const card = document.querySelector('.hud-card');
    const summary = document.querySelector('.action-summary');
    const visuals = [];
    const texts = [];
    const raw = [];
    const started = performance.now();
    for (let index = 0; index < 8; index += 1) {
      const state = index % 2 === 0 ? 'THINKING' : 'TOOL_RUNNING';
      const sessions = window.__hudDemo.read().sessions.map(item => item.id === 'cc-a'
        ? { ...item, runtime: { ...item.runtime, state, tool: 'Bash', detail: `step ${index}`, updatedAt: Date.now() }, attention: { state: 'NONE' }, tokens: { input: index + 1, output: index }, context: { used: index + 1, limit: 100, estimated: false } }
        : item);
      window.__hudDemo.push({ sessions, collectors: [] });
      await new Promise(resolve => setTimeout(resolve, 25));
      const session = window.__hudDemo.read().sessions.find(item => item.id === 'cc-a');
      raw.push(`${session.runtime.state}:${session.runtime.detail}`);
      visuals.push(card.dataset.visual);
      texts.push(summary.textContent);
    }
    const elapsed = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 160));
    const changes = visuals.filter((value, index) => index === 0 || value !== visuals[index - 1]);
    const distinctText = texts.filter((value, index) => index === 0 || value !== texts[index - 1]);
    return { elapsed, raw, changes, distinctText, text: summary.textContent };
  });
  assert.ok(burst.elapsed < 500, `burst took ${burst.elapsed}`);
  assert.equal(burst.raw.length, 8);
  assert.equal(burst.raw.filter(item => item.startsWith('THINKING')).length, 4);
  assert.ok(burst.raw.includes('TOOL_RUNNING:step 7'));
  assert.ok(burst.changes.length <= 2, `visual changes ${burst.changes.join(',')}`);
  assert.ok(burst.distinctText.length >= 2, `text samples ${burst.distinctText.join(' | ')}`);
  assert.match(burst.text, /step 7/);
  checks.push(`eight committed alternations in ${burst.elapsed.toFixed(0)} ms changed the track ${burst.changes.length} time(s); text moved through ${burst.distinctText.length} samples`);

  const bypasses = [];
  for (const attention of ['WAITING_USER', 'ERROR']) {
    const work = attention === 'WAITING_USER' ? 'THINKING' : 'TOOL_RUNNING';
    await page.evaluate(next => {
      const sessions = window.__hudDemo.read().sessions.map(item => item.id === 'cc-a'
        ? { ...item, attention: { state: 'NONE' }, runtime: { ...item.runtime, state: next, tool: next === 'TOOL_RUNNING' ? 'Bash' : undefined, detail: `settle ${next}` } }
        : item);
      window.__hudDemo.push({ sessions, collectors: [] });
    }, work);
    await page.waitForFunction(next => document.querySelector('.hud-card').dataset.visual === next, work);
    const result = await page.evaluate(async next => {
      const started = performance.now();
      const sessions = window.__hudDemo.read().sessions.map(item => item.id === 'cc-a'
        ? { ...item, attention: { state: next, message: 'boom' }, runtime: { ...item.runtime, state: 'IDLE', tool: undefined } }
        : item);
      window.__hudDemo.push({ sessions, collectors: [] });
      let visual = '';
      let banner = '';
      while (performance.now() - started < 100) {
        visual = document.querySelector('.hud-card').dataset.visual;
        banner = document.querySelector('.attention-banner')?.className ?? '';
        if (visual === 'IDLE' && banner.includes(next.toLowerCase())) return { elapsed: performance.now() - started, visual, banner };
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return { elapsed: performance.now() - started, visual, banner };
    }, attention);
    assert.equal(result.visual, 'IDLE', `${attention} visual ${result.visual}`);
    assert.match(result.banner, new RegExp(attention.toLowerCase()));
    assert.ok(result.elapsed < 100, `${attention} bypass ${result.elapsed}`);
    bypasses.push(`${attention} ${result.elapsed.toFixed(1)} ms`);
  }
  checks.push(`dwell bypass ${bypasses.join(', ')}`);

  const particle = await page.evaluate(async () => {
    const push = state => {
      const sessions = window.__hudDemo.read().sessions.map(item => item.id === 'cc-a'
        ? { ...item, attention: { state: 'NONE' }, runtime: { ...item.runtime, state, tool: state === 'TOOL_RUNNING' ? 'Bash' : undefined, detail: `move ${state}` } }
        : item);
      window.__hudDemo.push({ sessions, collectors: [] });
    };
    const waitVisual = async expected => {
      const started = performance.now();
      while (document.querySelector('.hud-card').dataset.visual !== expected) {
        if (performance.now() - started > 1500) return false;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return true;
    };
    push('THINKING');
    const thinking = await waitVisual('THINKING');
    await new Promise(resolve => setTimeout(resolve, 80));
    const node = document.querySelector('.track-particle');
    const before = Number(node.getAttribute('cx'));
    push('TOOL_RUNNING');
    const running = await waitVisual('TOOL_RUNNING');
    const samples = [Number(node.getAttribute('cx'))];
    for (let index = 0; index < 6; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 32));
      samples.push(Number(document.querySelector('.track-particle').getAttribute('cx')));
    }
    const deltas = samples.slice(1).map((value, index) => Math.abs(value - samples[index]));
    return {
      thinking,
      running,
      sameNode: document.querySelector('.track-particle') === node && node.isConnected,
      count: document.querySelectorAll('.track-particle').length,
      before,
      samples,
      maxDelta: Math.max(...deltas),
    };
  });
  assert.equal(particle.thinking, true);
  assert.equal(particle.running, true);
  assert.equal(particle.sameNode, true);
  assert.equal(particle.count, 1);
  assert.ok(particle.maxDelta < 20, `particle jump ${particle.maxDelta} from ${particle.samples.join(',')}`);
  assert.ok(particle.samples.at(-1) > particle.before, `particle did not advance ${particle.before} -> ${particle.samples.join(',')}`);
  checks.push(`particle stayed on one node and moved ${particle.before.toFixed(1)} -> ${particle.samples.at(-1).toFixed(1)}`);

  const motion = await page.evaluate(async () => {
    const push = state => {
      const sessions = window.__hudDemo.read().sessions.map(item => ({
        ...item,
        attention: { state: 'NONE' },
        runtime: { ...item.runtime, state, tool: state === 'TOOL_RUNNING' ? 'Bash' : undefined, detail: state === 'IDLE' ? undefined : 'moving' },
      }));
      window.__hudDemo.push({ sessions, collectors: [] });
    };
    const countFrames = ms => new Promise(resolve => {
      const orig = window.requestAnimationFrame;
      let frames = 0;
      window.requestAnimationFrame = function (callback) { frames += 1; return orig.call(window, callback); };
      setTimeout(() => { window.requestAnimationFrame = orig; resolve(frames); }, ms);
    });
    const setHidden = hidden => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    push('TOOL_RUNNING');
    await new Promise(resolve => setTimeout(resolve, 80));
    const busy = await countFrames(200);
    setHidden(true);
    await new Promise(resolve => setTimeout(resolve, 80));
    const hiddenQuiet = await countFrames(200);
    setHidden(false);
    await new Promise(resolve => setTimeout(resolve, 80));
    const resumed = await countFrames(200);
    push('IDLE');
    await new Promise(resolve => setTimeout(resolve, 700));
    const idleQuiet = await countFrames(250);
    return { busy, hiddenQuiet, resumed, idleQuiet };
  });
  assert.ok(motion.busy > 2, `expected motion frames, got ${motion.busy}`);
  assert.equal(motion.hiddenQuiet, 0);
  assert.ok(motion.resumed > 2, `expected resume frames, got ${motion.resumed}`);
  assert.equal(motion.idleQuiet, 0);
  checks.push(`frames working ${motion.busy}; hidden ${motion.hiddenQuiet}; resumed ${motion.resumed}; idle ${motion.idleQuiet}`);

  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.hud-shell').dataset.mode === 'compact');
  assert.equal(await page.locator('.pipeline-track').count(), 0);
  const compactQuiet = await page.evaluate(async () => {
    const orig = window.requestAnimationFrame;
    let frames = 0;
    window.requestAnimationFrame = function (callback) { frames += 1; return orig.call(window, callback); };
    await new Promise(resolve => setTimeout(resolve, 200));
    window.requestAnimationFrame = orig;
    return frames;
  });
  assert.equal(compactQuiet, 0);
  checks.push('compact unmounts the track and schedules no frames');

  await page.screenshot({ path: path.join(outputDirectory, 'side-dock.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(checks.map(item => `ok ${item}`).join('\n'));
}
main().finally(() => browser?.close());
