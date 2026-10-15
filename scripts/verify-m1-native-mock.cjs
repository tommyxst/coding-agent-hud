// App/IPC regression only. No OS window actions, real Agent or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [modulePath, outputDirectory] = process.argv.slice(2);
assert.ok(modulePath && outputDirectory && path.isAbsolute(modulePath) && path.isAbsolute(outputDirectory), 'Usage: node scripts/verify-m1-native-mock.cjs <absolute-playwright-module> <absolute-output-directory>');
const { chromium } = require(modulePath);
let browser;
async function main() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 500, height: 1200 } });
  const errors = [];
  const checks = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    globalThis.isTauri = true;
    let callbackId = 0;
    const callbacks = new Map();
    const listeners = new Map();
    const session = id => ({ id, environment: { type: 'windows' }, agent: { type: 'codex', name: 'Codex' }, project: { name: id, cwd: `C:/fixture/${id}` }, runtime: { state: 'THINKING', startedAt: Date.now(), updatedAt: Date.now() }, attention: { state: 'NONE' } });
    const snapshot = { sessions: [session('first'), session('second')], collectors: [] };
    window.__mock = { calls: [], requests: [], controlled: false, dragError: false, snapshot,
      emit(event, payload) { callbacks.get(listeners.get(event))({ event, id: 0, payload }); },
      settle(index, success) { const request = this.requests[index]; if (success) request.resolve(); else request.reject(new Error('fixture topmost failure')); },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event) { listeners.delete(event); } };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'hud' } },
      transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; },
      async invoke(command, args) {
        window.__mock.calls.push({ command, args });
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler; }
        if (command === 'plugin:event|unlisten' || command === 'set_privacy' || command === 'resize_window' || command === 'set_window_behavior') return;
        if (command === 'get_snapshot') return snapshot;
        if (command === 'set_always_on_top') {
          if (!window.__mock.controlled) return;
          return new Promise((resolve, reject) => window.__mock.requests.push({ resolve, reject, enabled: args.enabled }));
        }
        if (command === 'plugin:window|start_dragging') {
          if (window.__mock.dragError) throw new Error('fixture drag failure');
          return;
        }
        throw new Error(`Unexpected mock IPC: ${command}`);
      },
    };
  });
  await page.goto('http://127.0.0.1:1420');
  await page.locator('.connection-dot.live').waitFor();
  assert.equal(await page.locator('.app-native').count(), 1);
  assert.equal(await page.locator('.demo-mark').count(), 0);
  await page.evaluate(() => window.__mock.emit('hud:interaction', true));
  const pin = name => page.getByRole('button', { name, exact: true });
  await page.waitForFunction(() => window.__mock.calls.some(call => call.command === 'set_always_on_top' && call.args.enabled === true) && !document.querySelector('[aria-label="取消窗口置顶"]').disabled);
  await page.evaluate(() => {
    const next = structuredClone(window.__mock.snapshot);
    next.sessions[0].runtime.state = 'TOOL_RUNNING'; next.sessions[0].runtime.tool = 'Read';
    window.__mock.emit('hud:snapshot', next);
  });
  await page.waitForFunction(() => document.querySelector('.pipeline-tool_running .track-particle')?.getAnimations().length === 1);
  const screenOrigin = await page.locator('.track-particle').evaluate(node => {
    window.__mockParticle = node;
    const animation = node.getAnimations()[0];
    animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) * 0.5;
    const rect = node.getBoundingClientRect(); return rect.x + rect.width / 2;
  });
  await page.evaluate(() => {
    const next = structuredClone(window.__mock.snapshot);
    next.sessions[0].runtime.state = 'TOOL_RUNNING'; next.sessions[0].runtime.tool = 'A-very-long-observed-tool-name';
    window.__mock.emit('hud:snapshot', next);
  });
  await page.locator('.pipeline-target[title="A-very-long-observed-tool-name"]').waitFor();
  const screenAfter = await page.locator('.track-particle').evaluate(node => {
    const rect = node.getBoundingClientRect(); return { same: node === window.__mockParticle, center: rect.x + rect.width / 2 };
  });
  assert.ok(screenAfter.same && Math.abs(screenAfter.center - screenOrigin) < 0.1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  checks.push('same-state tool label length change keeps the particle screen origin and layout stable');
  await page.evaluate(() => { window.__mock.controlled = true; });
  await pin('取消窗口置顶').click();
  await page.waitForFunction(() => window.__mock.requests.length === 1 && document.querySelector('[aria-label="取消窗口置顶"]').disabled);
  assert.equal(await pin('取消窗口置顶').isDisabled(), true);
  await page.evaluate(() => window.__mock.settle(0, false));
  await page.getByRole('alert').filter({ hasText: '窗口置顶失败' }).waitFor();
  await pin('关闭窗口置顶错误').click();
  await pin('取消窗口置顶').click();
  await page.waitForFunction(() => window.__mock.requests.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__mock.requests.map(request => request.enabled)), [false, false]);
  await page.evaluate(() => window.__mock.settle(1, true));
  await page.waitForFunction(() => document.querySelector('[aria-label="窗口置顶"]')?.getAttribute('aria-pressed') === 'false' && !document.querySelector('[aria-label="窗口置顶"]').disabled);
  assert.equal(await page.locator('.hud-card').getAttribute('data-primary'), 'first');
  checks.push('topmost failure can retry the identical target without reconnecting or selecting a session');

  await pin('窗口置顶').click();
  await page.waitForFunction(() => window.__mock.requests.length === 3);
  await page.evaluate(() => window.__mock.settle(2, true));
  await page.waitForFunction(() => !document.querySelector('[aria-label="取消窗口置顶"]')?.disabled);
  await pin('取消窗口置顶').click();
  await page.waitForFunction(() => window.__mock.requests.length === 4);
  await pin('HUD 设置').click();
  await page.getByRole('button', { name: '重置为默认', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__mock.requests.length), 4, 'new request must wait behind in-flight request');
  await page.evaluate(() => window.__mock.settle(3, true));
  await page.waitForFunction(() => window.__mock.requests.length === 5);
  await page.evaluate(() => window.__mock.settle(4, false));
  await page.getByRole('alert').filter({ hasText: '窗口置顶失败' }).waitFor();
  assert.equal(await pin('窗口置顶').getAttribute('aria-pressed'), 'false');
  assert.equal(await pin('窗口置顶').isDisabled(), false);
  checks.push('serialized stale success remains applied truth when latest request fails');
  await pin('关闭设置').click();

  const drag = pin('拖动窗口');
  const dragCalls = () => page.evaluate(() => window.__mock.calls.filter(call => call.command === 'plugin:window|start_dragging').length);
  await drag.dispatchEvent('pointerdown', { button: 2 });
  assert.equal(await dragCalls(), 0);
  await page.evaluate(() => { window.__mock.dragError = true; });
  await drag.dispatchEvent('pointerdown', { button: 0 });
  await page.getByRole('alert').filter({ hasText: '窗口拖动失败' }).waitFor();
  assert.equal(await dragCalls(), 1);
  await page.evaluate(() => { window.__mock.dragError = false; });
  await drag.dispatchEvent('pointerdown', { button: 0 });
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="alert"]')].some(node => node.textContent.includes('窗口拖动失败')));
  assert.equal(await dragCalls(), 2);
  assert.equal(await page.locator('.hud-card').getAttribute('data-primary'), 'first');
  checks.push('left pointer invokes drag once; right pointer ignored; success clears drag failure');
  await pin('收起为 Compact').click();
  await drag.dispatchEvent('pointerdown', { button: 0 });
  assert.equal(await dragCalls(), 3);
  assert.equal(await page.locator('.hud-shell').getAttribute('data-mode'), 'compact');
  assert.equal(await pin('窗口置顶').getAttribute('aria-pressed'), 'false');
  checks.push('Compact drag and pin retain the same window semantics');

  await page.getByRole('button', { name: '展开 first 会话', exact: true }).click();
  await page.getByRole('button', { name: '会话详情', exact: false }).click();
  await page.evaluate(() => { const next = structuredClone(window.__mock.snapshot); next.sessions[0].runtime.state = 'IDLE'; next.sessions[1].attention.state = 'ERROR'; window.__mock.emit('hud:snapshot', next); });
  assert.equal(await page.locator('.hud-card').getAttribute('data-primary'), 'first');
  assert.equal(await page.locator('.detail-drawer').count(), 1);
  await pin('Auto').click();
  assert.equal(await page.locator('.hud-card').getAttribute('data-primary'), 'second');
  assert.equal(await page.locator('.detail-drawer').count(), 0);
  await page.locator('.secondary-row').click();
  assert.equal(await page.locator('.detail-drawer').count(), 0);
  checks.push('live App snapshot keeps inspected details; Auto switches and clears old intent');
  assert.deepEqual(errors, []);
  const result = { checks, count: checks.length, pageErrors: errors, nativeIpcMockOnly: true, osActions: 0, modelCalls: 0 };
  fs.writeFileSync(path.join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
