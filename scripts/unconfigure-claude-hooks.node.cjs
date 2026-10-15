const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { removeHudHooks, unconfigure } = require('./unconfigure-claude-hooks.cjs');
const { writeSettings } = require('./configure-claude-hooks.cjs');
const helper = 'C:/HUD Folder/agent-hud-hook.exe';
const hud = { type: 'command', command: `"${helper}"` };

test('removes only the exact helper command and preserves unrelated groups and settings', () => {
  const other = { type: 'command', command: `"${helper}" --other-mode` };
  const original = { permissions: { allow: ['Read'] }, hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [hud, other], timeout: 10 }, { matcher: 'Read', hooks: [other] }],
    Stop: [{ hooks: [hud] }],
    Custom: [{ hooks: [{ type: 'prompt', command: hud.command }] }],
    StopFailure: [],
  } };
  const saved = structuredClone(original);
  const result = removeHudHooks(original, helper);
  assert.deepEqual(original, saved);
  assert.deepEqual(result.removed, ['PreToolUse', 'Stop']);
  assert.deepEqual(result.settings.permissions, original.permissions);
  assert.deepEqual(result.settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [other], timeout: 10 }, { matcher: 'Read', hooks: [other] }]);
  assert.equal(Object.hasOwn(result.settings.hooks, 'Stop'), false);
  assert.deepEqual(result.settings.hooks.Custom, original.hooks.Custom);
  assert.deepEqual(result.settings.hooks.StopFailure, []);
  assert.deepEqual(removeHudHooks(result.settings, helper).removed, []);
});

test('rejects malformed structures without replacing them', () => {
  for (const value of [null, [], { hooks: null }, { hooks: [] }, { hooks: { Stop: null } }, { hooks: { Stop: [{}] } }]) {
    assert.throws(() => removeHudHooks(value, helper));
  }
  assert.deepEqual(removeHudHooks({ other: true }, helper), { settings: { other: true }, removed: [] });
});

test('backs up exact bytes, preserves BOM/CRLF, works after helper deletion and is idempotent', () => {
  assert.ok(process.env.PI_SCRATCH_DIR, 'Tests require an explicit scratch directory');
  const root = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, 'hook-remove-test-'));
  try {
    const settingsPath = path.join(root, 'settings.json');
    const helperPath = path.join(root, 'deleted-helper.exe');
    const settings = { permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${helperPath.replaceAll('\\', '/')}"` }] }] } };
    const original = Buffer.from('\uFEFF' + JSON.stringify(settings, null, 2).replaceAll('\n', '\r\n') + '\r\n');
    fs.writeFileSync(settingsPath, original);
    const result = unconfigure(settingsPath, helperPath, root);
    assert.deepEqual(result.removed, ['Stop']);
    assert.ok(fs.readFileSync(result.backup).equals(original));
    const updated = fs.readFileSync(settingsPath, 'utf8');
    assert.ok(updated.startsWith('\uFEFF'));
    assert.ok(updated.includes('\r\n'));
    assert.deepEqual(JSON.parse(updated.slice(1)), { permissions: settings.permissions, hooks: {} });
    assert.deepEqual(unconfigure(settingsPath, helperPath, root), { removed: [], backup: null });
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('concurrent edits are not overwritten and the original backup remains exact', () => {
  assert.ok(process.env.PI_SCRATCH_DIR);
  const root = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, 'hook-race-test-'));
  try {
    const settingsPath = path.join(root, 'settings.json');
    const original = Buffer.from('{"old":true}\n');
    const current = Buffer.from('{"new":true}\n');
    fs.writeFileSync(settingsPath, current);
    assert.throws(() => writeSettings(settingsPath, root, original, { changed: true }), /changed during update/);
    assert.ok(fs.readFileSync(settingsPath).equals(current));
    const files = fs.readdirSync(root);
    assert.equal(files.some(name => name.endsWith('.pending')), false);
    const backup = files.find(name => name.startsWith('claude-settings-before-hud-'));
    assert.ok(fs.readFileSync(path.join(root, backup)).equals(original));
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('HUD writers cannot enter the comparison/replacement window concurrently', () => {
  assert.ok(process.env.PI_SCRATCH_DIR);
  const root = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, 'hook-lock-test-'));
  const read = fs.readFileSync;
  try {
    const settingsPath = path.join(root, 'settings.json');
    const original = Buffer.from('{"old":true}\n');
    fs.writeFileSync(settingsPath, original);
    let attempted = false;
    fs.readFileSync = function(file, ...args) {
      if (file === settingsPath && !attempted) {
        attempted = true;
        assert.throws(() => writeSettings(settingsPath, root, original, { competing: true }), { code: 'EEXIST' });
      }
      return read.call(this, file, ...args);
    };
    writeSettings(settingsPath, root, original, { winner: true });
    assert.equal(attempted, true);
    assert.deepEqual(JSON.parse(read(settingsPath, 'utf8')), { winner: true });
    assert.equal(fs.existsSync(`${settingsPath}.hud.lock`), false);
    assert.equal(fs.readdirSync(root).filter(name => name.startsWith('claude-settings-before-hud-')).length, 1);
  } finally {
    fs.readFileSync = read;
    fs.rmSync(root, { recursive: true });
  }
});
