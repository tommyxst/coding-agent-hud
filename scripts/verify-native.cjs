// Windows fixture verification only; never launches the real Agent or calls a model.
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
const project = path.join(directory, 'native-e2e-project');
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(project);
const logfile = fs.openSync(path.join(directory, 'native.log'), 'a');
const app = cp.spawn(path.join(projectRoot, 'src-tauri/target/release/coding-agent-hud.exe'), [], {
  windowsHide: true, stdio: ['ignore', logfile, logfile],
  env: { ...process.env, CODEX_HOME: path.join(directory, 'codex'), HUD_EVENT_DIR: path.join(directory, 'events'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
});
let browser, fixture;
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
async function main() {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 'WebView CDP');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.localhost')), 'native asset page');
  await page.waitForSelector('.app-native', { timeout: READINESS_TIMEOUT_MS });
  await page.waitForSelector('.connection-dot.live', { timeout: READINESS_TIMEOUT_MS });
  const snapshot = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_snapshot'));
  assert.equal((await snapshot()).sessions.length, 0);
  assert.equal(await page.locator('.demo-mark').count(), 0);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('set_privacy', { showCommandDetail: false }));

  const rollout = path.join(sessions, 'rollout-native-fixture.jsonl');
  fs.writeFileSync(rollout, record('session_meta', { id: 'native-fixture', cwd: project, cli_version: 'fixture-only' }));
  const deps = path.join(projectRoot, 'src-tauri/target/debug/deps');
  const testBinaries = fs.readdirSync(deps).filter(file => /^coding_agent_hud_lib-.*\.exe$/.test(file));
  assert.equal(testBinaries.length, 1, 'Expected one compiled test binary; supply a clean cargo test build');
  const actor = path.join(directory, 'codex.exe');
  fs.copyFileSync(path.join(deps, testBinaries[0]), actor);
  fixture = cp.spawn(actor, ['--exact', 'native::tests::fixture_process', '--nocapture'], {
    windowsHide: true, stdio: ['pipe', 'pipe', logfile],
    env: { ...process.env, HUD_NATIVE_FIXTURE_FILE: rollout },
  });
  let ready = '';
  fixture.stdout.on('data', chunk => { ready += chunk; });
  await until(() => ready.includes('HUD_FIXTURE_READY'), 'synthetic file holder');
  fs.appendFileSync(rollout, record('turn_context', { model: 'fixture-model' }) + record('event_msg', { type: 'task_started' }));
  await until(async () => (await snapshot()).sessions[0]?.runtime.state === 'THINKING', 'discovery and activity');
  await page.waitForSelector('.project-name', { timeout: READINESS_TIMEOUT_MS });
  assert.equal(await page.locator('.project-name').textContent(), 'native-e2e-project');
  assert.equal((await snapshot()).sessions[0].workspace.agentPid, fixture.pid);
  assert.equal(await page.locator('.demo-controls').count(), 0);

  fs.appendFileSync(rollout, record('event_msg', { type: 'exec_command_begin', command: ['DO_NOT_PUBLISH'] }));
  await until(async () => (await snapshot()).sessions[0]?.runtime.state === 'TOOL_RUNNING', 'incremental tool update');
  assert.equal((await snapshot()).sessions[0].runtime.detail, undefined);
  assert.ok(!(await page.locator('body').textContent()).includes('DO_NOT_PUBLISH'));
  await page.screenshot({ path: path.join(directory, 'native-fixture.png') });
  assert.ok(!(await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))).some(url => /\/demo-[^/]+\.js/.test(url)));

  const exit = new Promise(resolve => fixture.once('exit', resolve));
  fixture.stdin.end('x');
  assert.equal(await exit, 0);
  fixture = null;
  await until(async () => (await snapshot()).sessions.length === 0, 'process exit cleanup');
  await page.waitForSelector('.empty-card', { timeout: READINESS_TIMEOUT_MS });
  console.log(JSON.stringify({ nativeIpc: 'passed', nativeAssetLoading: 'passed', noDemoImport: 'passed', discovery: 'passed', activityUpdate: 'passed', defaultPrivacy: 'passed', processExitCleanup: 'passed', fixtureOnly: true, modelCalls: 0, directory }, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (fixture) fixture.kill();
  if (browser) await browser.close();
  app.kill();
  fs.closeSync(logfile);
});
