// Isolated Windows placement verification; no real Agent or model invocation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const [outputDirectory, playwrightModule, portText] = process.argv.slice(2);
assert.ok(outputDirectory && playwrightModule && portText,
  'Usage: node scripts/verify-placement.cjs <absolute-output-dir> <absolute-playwright-module> <cdp-port>');
assert.ok(path.isAbsolute(outputDirectory) && path.isAbsolute(playwrightModule), 'Paths must be absolute');
const port = Number(portText);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid CDP port');
const { chromium } = require(playwrightModule);
const projectRoot = path.resolve(__dirname, '..');
const TIMEOUT_MS = 15000;
const INTERVAL_MS = 75;
const SAVE_SETTLE_MS = 600;
const directory = fs.mkdtempSync(path.join(outputDirectory, 'native-placement-'));
const placement = path.join(directory, 'window-position.json');
const logfile = fs.openSync(path.join(directory, 'native.log'), 'a');
fs.mkdirSync(path.join(directory, 'codex/sessions'), { recursive: true });
let app, browser, page;
const checks = [];
const pageErrors = [];
async function until(check, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError;
  do {
    try { const result = await check(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error(`Timeout: ${label}${lastError ? `; ${lastError.message}` : ''}`);
}
function powershell(script, args) {
  return cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, script), ...args],
    { encoding: 'utf8', windowsHide: true });
}
function state() {
  return JSON.parse(powershell('read-window-state.ps1', ['-ProcessId', String(app.pid)]));
}
function action(name, x, y) {
  const args = ['-ProcessId', String(app.pid), '-Action', name];
  if (x !== undefined) args.push('-X', String(x), '-Y', String(y));
  powershell('window-fixture-action.ps1', args);
}
function saved() { return JSON.parse(fs.readFileSync(placement, 'utf8')); }
function inside(window) {
  const { bounds: b, workArea: w } = window;
  return b.x >= w.x && b.y >= w.y && b.x + b.width <= w.x + w.width && b.y + b.height <= w.y + w.height;
}
function near(actual, expected, tolerance = 1) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`); }
function assertNative(window) {
  assert.ok(window.noActivate && window.toolWindow);
  assert.ok(inside(window), 'HUD must remain inside the work area');
}
async function start() {
  app = cp.spawn(path.join(projectRoot, 'src-tauri/target/release/coding-agent-hud.exe'), [], {
    windowsHide: true, stdio: ['ignore', logfile, logfile],
    env: { ...process.env, CODEX_HOME: path.join(directory, 'codex'), HUD_EVENT_DIR: path.join(directory, 'events'),
      HUD_PLACEMENT_FILE: placement, WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview-profile'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 'WebView CDP');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.localhost')), 'HUD page');
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForSelector('.connection-dot.live', { timeout: TIMEOUT_MS });
  const snapshot = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_snapshot'));
  assert.equal(snapshot.sessions.length, 0, 'Fixture must not read real sessions');
}
async function stop(name = 'Close', x, y) {
  action(name, x, y);
  await until(() => app.exitCode !== null, 'normal HUD exit');
  assert.equal(app.exitCode, 0);
  await browser.close();
  browser = undefined;
  app = undefined;
}
async function diagnostic(expected) {
  const result = await until(async () => {
    const snapshot = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_snapshot'));
    return snapshot.collectors.find(item => item.agent === 'window-placement' && item.state === expected);
  }, `placement ${expected} diagnostic`);
  await page.getByRole('button', { name: 'Collector 状态', exact: true }).click();
  const card = page.locator('.collector-list li').filter({ hasText: '窗口位置' });
  await card.getByText(expected === 'warning' ? 'Warning' : 'Error', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(directory, `placement-${expected}.png`) });
  await page.getByRole('button', { name: '关闭 Collector 状态', exact: true }).click();
  return result;
}
async function main() {
  await start();
  let window = state();
  assertNative(window);
  assert.equal(window.visible, false);
  const x = Math.round(window.workArea.x + 120 * window.scale);
  const y = Math.round(window.workArea.y + 100 * window.scale);
  action('Move', x, y);
  await until(() => fs.existsSync(placement) && Math.abs(saved().x - 120) < 1, 'debounced position save');
  const original = saved();
  near(original.y, 100);
  assert.equal(original.version, 1);
  assert.ok(original.monitor.startsWith('\\\\?\\'), 'Save the monitor interface path, not DISPLAY1');
  assert.deepEqual(Object.keys(original).sort(), ['monitor', 'version', 'x', 'y']);
  checks.push('native move saves only monitor interface ID and logical work-area offsets');
  const beforeMinimize = fs.readFileSync(placement, 'utf8');
  action('Minimize');
  assert.equal(state().minimized, true);
  await delay(SAVE_SETTLE_MS);
  assert.equal(fs.readFileSync(placement, 'utf8'), beforeMinimize);
  checks.push('minimization does not overwrite saved coordinates');
  await stop();
  await start();
  window = state();
  near((window.bounds.x - window.workArea.x) / window.scale, original.x);
  near((window.bounds.y - window.workArea.y) / window.scale, original.y);
  assertNative(window);
  assert.equal(window.visible, false);
  checks.push('normal restart restores logical position without revealing a sessionless HUD');
  action('Move', window.workArea.x + window.workArea.width - window.bounds.width,
    window.workArea.y + window.workArea.height - window.bounds.height);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('resize_window', { width: 520, height: 360 }));
  assertNative(state());
  checks.push('content growth is constrained to the work area');
  action('Move', -100000, -100000);
  action('TrayClick');
  await until(() => { const window = state(); return window.visible && inside(window); }, 'offscreen tray recovery');
  assertNative(state());
  checks.push('explicit tray reveal recovers offscreen HUD without changing native window flags');
  const target = state();
  const exitX = Math.round(target.workArea.x + 170 * target.scale);
  const exitY = Math.round(target.workArea.y + 140 * target.scale);
  await stop('MoveAndClose', exitX, exitY);
  near(saved().x, 170);
  near(saved().y, 140);
  checks.push('immediate normal exit flushes the last native move');
  fs.writeFileSync(placement, 'INVALID POSITION FIXTURE');
  await start();
  await diagnostic('error');
  action('Move', x, y);
  await delay(SAVE_SETTLE_MS);
  assert.equal(fs.readFileSync(placement, 'utf8'), 'INVALID POSITION FIXTURE');
  assertNative(state());
  await stop();
  checks.push('invalid configuration is diagnosed and preserved after movement and exit');
  fs.writeFileSync(placement, JSON.stringify({ version: 1, monitor: 'removed-fixture-display', x: 50000, y: 50000 }));
  await start();
  await diagnostic('warning');
  assertNative(state());
  await stop();
  checks.push('missing saved monitor produces an explicit diagnostic and visible primary-screen recovery');
  await start();
  fs.unlinkSync(placement);
  fs.mkdirSync(placement);
  action('Move', x, y);
  await diagnostic('error');
  assert.ok(fs.statSync(placement).isDirectory(), 'Failed save must not replace destination');
  await stop();
  checks.push('atomic replacement failure is diagnosed without overwriting the destination or hanging on exit');
  assert.deepEqual(pageErrors, []);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ checks, pageErrors, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ directory, checks, pageErrors, modelCalls: 0 }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (app && app.exitCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve));
    app.kill();
    await exited;
  }
  if (browser) await browser.close();
  fs.closeSync(logfile);
});
