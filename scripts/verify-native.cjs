// Windows fixture verification only; never launches a real Agent or calls a model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const [outputDirectory, playwrightModule, portText] = process.argv.slice(2);
assert.ok(outputDirectory && playwrightModule && portText,
  'Usage: node scripts/verify-native.cjs <absolute-output-dir> <absolute-playwright-module> <cdp-port>');
assert.ok(path.isAbsolute(outputDirectory) && path.isAbsolute(playwrightModule), 'Output and module paths must be absolute');
const port = Number(portText);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid CDP port');
const { chromium } = require(playwrightModule);
const projectRoot = path.resolve(__dirname, '..');
const READINESS_TIMEOUT_MS = 15000;
const READINESS_INTERVAL_MS = 75;
const directory = path.join(outputDirectory, `native-e2e-${Date.now()}`);
const sessions = path.join(directory, 'codex/sessions');
const events = path.join(directory, 'events');
const project = path.join(directory, 'native-e2e-project');
const claudeProject = path.join(directory, 'claude-e2e-project');
for (const target of [sessions, events, project, claudeProject]) fs.mkdirSync(target, { recursive: true });
const logfile = fs.openSync(path.join(directory, 'native.log'), 'a');
let app, browser;
const fixtures = [];
const checks = [];
async function until(check, label) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastError;
  do {
    try { const result = await check(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(READINESS_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error(`Timeout: ${label}${lastError ? `; ${lastError.message}` : ''}`);
}
function record(type, payload) { return JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n'; }
async function actor(name, heldFile, binary) {
  const executable = path.join(directory, `${name}.exe`);
  fs.copyFileSync(binary, executable);
  const process = cp.spawn(executable, ['--exact', 'native::tests::fixture_process', '--nocapture'], {
    windowsHide: true, stdio: ['pipe', 'pipe', logfile], env: { ...global.process.env, HUD_NATIVE_FIXTURE_FILE: heldFile },
  });
  fixtures.push(process);
  let ready = '';
  process.stdout.on('data', chunk => { ready += chunk; });
  await until(() => ready.includes('HUD_FIXTURE_READY'), `${name} synthetic file holder`);
  return process;
}
function hook(kind, process, toolUseId, filename) {
  const target = path.join(events, filename);
  fs.writeFileSync(`${target}.pending`, JSON.stringify({ kind, sessionId: 'claude-fixture', cwd: claudeProject, timestamp: Date.now(), agentPid: process.pid, tool: 'Read', model: null, notificationType: null, toolUseId }));
  fs.renameSync(`${target}.pending`, target);
}
function windowState() {
  return JSON.parse(cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'read-window-state.ps1'), '-ProcessId', String(app.pid)], { encoding: 'utf8', windowsHide: true }));
}
function windowAction(action) {
  cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'window-fixture-action.ps1'), '-ProcessId', String(app.pid), '-Action', action], { windowsHide: true });
}
async function stopFixture(process) {
  const exit = new Promise(resolve => process.once('exit', resolve));
  process.stdin.end('x');
  assert.equal(await exit, 0);
}
async function main() {
  const deps = path.join(projectRoot, 'src-tauri/target/debug/deps');
  const testBinaries = fs.readdirSync(deps).filter(file => /^coding_agent_hud_lib-.*\.exe$/.test(file));
  assert.equal(testBinaries.length, 1, 'Expected one compiled test binary; supply a clean cargo test build');
  const binary = path.join(deps, testBinaries[0]);
  const rollout = path.join(sessions, 'rollout-native-fixture.jsonl');
  fs.writeFileSync(rollout, record('session_meta', { id: 'native-fixture', cwd: project, cli_version: 'fixture-only' })
    + record('response_item', { type: 'function_call', call_id: 'history-codex', name: 'Read', arguments: 'PRIVATE_HISTORY' })
    + record('response_item', { type: 'function_call_output', call_id: 'history-codex', output: 'PRIVATE_HISTORY' })
    + record('response_item', { type: 'reasoning', summary: 'PRIVATE_HISTORY' }));
  const codex = await actor('codex', rollout, binary);
  const heldHookFile = path.join(directory, 'claude-held-file');
  fs.writeFileSync(heldHookFile, 'fixture only');
  const claude = await actor('claude', heldHookFile, binary);
  hook('PreToolUse', claude, 'history-hook', '000-history.json');
  app = cp.spawn(path.join(projectRoot, 'src-tauri/target/release/coding-agent-hud.exe'), [], {
    windowsHide: true, stdio: ['ignore', logfile, logfile],
    env: { ...process.env, CODEX_HOME: path.join(directory, 'codex'), HUD_EVENT_DIR: events,
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview-profile'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 'WebView CDP');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.localhost')), 'native asset page');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.app-native', { timeout: READINESS_TIMEOUT_MS });
  await page.waitForSelector('.connection-dot.live', { timeout: READINESS_TIMEOUT_MS });
  const snapshot = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_snapshot'));
  const session = async type => (await snapshot()).sessions.find(session => session.agent.type === type);
  await until(async () => (await snapshot()).sessions.length === 2, 'startup discovery of both fixture processes');
  assert.equal(await page.locator('.demo-mark').count(), 0);
  assert.equal(await page.locator('.demo-controls').count(), 0);
  assert.ok(fs.existsSync(path.join(directory, 'webview-profile')), 'WebView settings must be isolated');
  for (const type of ['claude', 'codex']) assert.deepEqual((await session(type)).recentTools ?? [], []);
  assert.equal((await session('codex')).workspace.agentPid, codex.pid);
  assert.equal((await session('claude')).workspace.agentPid, claude.pid);
  checks.push('verified startup discovery; historical Codex and Hook tool feedback suppressed; isolated WebView settings');

  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('set_privacy', { showCommandDetail: false }));
  fs.appendFileSync(rollout, record('event_msg', { type: 'exec_command_begin', call_id: 'live-exec', command: ['DO_NOT_PUBLISH'] }));
  await until(async () => (await session('codex')).runtime.state === 'TOOL_RUNNING', 'incremental tool update');
  assert.equal((await session('codex')).runtime.detail, undefined);
  checks.push('incremental Tool Running and default privacy');
  fs.appendFileSync(rollout, record('response_item', { type: 'function_call', call_id: 'short-live', name: 'Read', arguments: 'PRIVATE_ARGUMENT' })
    + record('response_item', { type: 'function_call_output', call_id: 'short-live', output: 'PRIVATE_OUTPUT' })
    + record('response_item', { type: 'reasoning', summary: 'PRIVATE_REASONING' }));
  await until(async () => (await session('codex')).recentTools?.some(tool => tool.id === 'short-live' && tool.status === 'RETURNED'), 'short live batch observation');
  assert.equal((await session('codex')).runtime.state, 'THINKING');
  assert.ok(!(JSON.stringify(await snapshot())).includes('PRIVATE_'));
  checks.push('short Codex call/return batch retained as metadata while latest runtime remains Thinking');
  hook('PreToolUse', claude, 'live-hook', '100-live-begin.json');
  await until(async () => (await session('claude')).recentTools?.some(tool => tool.id === 'live-hook' && tool.status === 'OBSERVED'), 'live Hook observation');
  hook('PostToolUse', claude, 'live-hook', '101-live-return.json');
  await until(async () => (await session('claude')).recentTools?.some(tool => tool.id === 'live-hook' && tool.status === 'RETURNED'), 'correlated Hook return');
  assert.equal((await session('claude')).runtime.state, 'THINKING');
  await until(() => fs.readdirSync(events).length === 0, 'consumed Hook metadata');
  checks.push('live Claude Hook correlated by tool_use_id; metadata consumed; latest runtime Thinking');

  // DOM-dispatched UI clicks reach real Tauri IPC, but do not prove physical mouse behavior.
  await page.getByRole('button', { name: 'HUD 设置', exact: true }).evaluate(node => node.click());
  const clickThrough = page.getByRole('checkbox', { name: '鼠标穿透', exact: false });
  await clickThrough.evaluate(node => node.click());
  await page.getByRole('button', { name: '关闭设置', exact: true }).evaluate(node => node.click());
  await page.waitForFunction(() => !document.querySelector('[aria-label="取消窗口置顶"]').disabled);
  const initialStyle = windowState();
  assert.ok(initialStyle.topmost && initialStyle.toolWindow && initialStyle.noActivate && !initialStyle.clickThrough);
  await page.getByRole('button', { name: '取消窗口置顶', exact: true }).evaluate(node => node.click());
  await page.waitForFunction(() => document.querySelector('[aria-label="窗口置顶"]')?.getAttribute('aria-pressed') === 'false' && !document.querySelector('[aria-label="窗口置顶"]').disabled);
  assert.equal(windowState().topmost, false);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('set_window_behavior', { clickThrough: false }));
  const offStyle = windowState();
  assert.ok(!offStyle.topmost && offStyle.toolWindow && offStyle.noActivate);
  const previousUpdate = (await session('codex')).runtime.updatedAt;
  windowAction('Minimize');
  assert.equal(windowState().minimized, true);
  fs.appendFileSync(rollout, record('response_item', { type: 'reasoning', summary: 'fixture-only' }));
  await until(async () => (await session('codex')).runtime.updatedAt > previousUpdate, 'background snapshot while minimized');
  assert.equal(windowState().minimized, true, 'background telemetry must not undo a user minimize');
  checks.push('background snapshot does not restore a minimized HUD');
  for (const action of ['Minimize', 'Hide', 'Lower']) {
    windowAction('TrayClick');
    await until(() => page.locator('.selection-label').textContent().then(text => text.includes('临时交互')), 'tray enters interaction');
    windowAction(action);
    const before = windowState();
    if (action === 'Minimize') assert.equal(before.minimized, true);
    if (action === 'Hide') assert.equal(before.visible, false);
    windowAction('TrayClick');
    await until(() => { const state = windowState(); return state.visible && !state.minimized && (action !== 'Lower' || state.normalZOrder < before.normalZOrder); }, `tray restores ${action}`);
    const restored = windowState();
    assert.equal(restored.topmost, false);
    assert.equal(restored.foreground, before.foreground, 'tray restore must not take keyboard focus');
    assert.ok(restored.toolWindow && restored.noActivate && !restored.clickThrough);
    assert.ok((await page.locator('.selection-label').textContent()).includes('临时交互'));
    checks.push(`tray restores ${action} without focus/topmost changes, even when already interactive`);
  }
  await page.getByRole('button', { name: '窗口置顶', exact: true }).evaluate(node => node.click());
  await page.waitForFunction(() => document.querySelector('[aria-label="取消窗口置顶"]')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('[aria-label="取消窗口置顶"]').disabled);
  assert.equal(windowState().topmost, true);
  checks.push('pin UI toggles actual WS_EX_TOPMOST; interaction configuration preserves other window styles');
  await page.getByRole('button', { name: 'HUD 设置', exact: true }).evaluate(node => node.click());
  await page.getByRole('slider', { name: '界面字号', exact: true }).evaluate(node => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '20');
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.action-summary')).fontSize === '20px');
  await page.waitForFunction(() => {
    const rect = document.querySelector('.window-content').getBoundingClientRect();
    return Math.ceil(rect.width) <= innerWidth && Math.ceil(rect.height) <= innerHeight;
  }, null, { timeout: READINESS_TIMEOUT_MS }).catch(async error => {
    fs.writeFileSync(path.join(directory, 'layout-failure.json'), JSON.stringify(await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, content: document.querySelector('.window-content').getBoundingClientRect().toJSON(), alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) })), null, 2));
    await page.screenshot({ path: path.join(directory, 'layout-failure.png') });
    throw error;
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: '关闭设置', exact: true }).evaluate(node => node.click());
  await page.getByRole('button', { name: '会话详情', exact: false }).evaluate(node => node.click());
  await page.waitForFunction(() => {
    const rect = document.querySelector('.window-content').getBoundingClientRect();
    return Math.ceil(rect.width) <= innerWidth && Math.ceil(rect.height) <= innerHeight;
  }, null, { timeout: READINESS_TIMEOUT_MS });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  checks.push('bundled native font 20 and expanded details fit the resized window');
  assert.ok(!(await page.locator('body').textContent()).includes('DO_NOT_PUBLISH'));
  assert.ok(!(await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))).some(url => /\/demo-[^/]+\.js/.test(url)));
  await page.screenshot({ path: path.join(directory, 'native-fixture.png') });
  checks.push('native assets contain no DEMO import and no private command content');
  await page.getByRole('button', { name: '取消窗口置顶', exact: true }).evaluate(node => node.click());
  await page.waitForFunction(() => document.querySelector('[aria-label="窗口置顶"]')?.getAttribute('aria-pressed') === 'false' && !document.querySelector('[aria-label="窗口置顶"]').disabled);

  await stopFixture(codex);
  await stopFixture(claude);
  await until(async () => (await snapshot()).sessions.length === 0, 'both process exit cleanups');
  await page.waitForSelector('.empty-card', { timeout: READINESS_TIMEOUT_MS });
  assert.equal(windowState().visible, true, 'explicit tray interaction retains the diagnostic view');
  windowAction('Minimize');
  const emptyMinimized = windowState();
  assert.equal(emptyMinimized.minimized, true);
  windowAction('TrayClick');
  await until(() => { const state = windowState(); return state.visible && !state.minimized; }, 'sessionless tray recovery');
  const emptyRestored = windowState();
  assert.ok(!emptyRestored.topmost && emptyRestored.noActivate);
  assert.equal(emptyRestored.foreground, emptyMinimized.foreground);
  checks.push('sessionless diagnostic window also restores without focus/topmost changes');
  assert.deepEqual(errors, []);
  checks.push('both process exits clear sessions; no page errors');
  const result = { checks, count: checks.length, fixtureOnly: true, simulatedUiClicks: true, simulatedTrayNotifications: true, globalWinDTested: false, physicalDragVerified: false, modelCalls: 0, directory, initialStyle, offStyle, pageErrors: errors };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  for (const process of fixtures) if (process.exitCode === null) process.kill();
  if (browser) await browser.close();
  if (app && app.exitCode === null) app.kill();
  fs.closeSync(logfile);
});
