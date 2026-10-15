const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mergeHudHooks, configure } = require('./configure-claude-hooks.cjs');
const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/claude-hooks.example.json'), 'utf8'));
const helper = 'C:/HUD Folder/agent-hud-hook.exe';

test('preserves original settings and all existing hooks, and is idempotent', () => {
  const original = { permissions: { allow: ['Read'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-check' }] }], StopFailure: [] } };
  const saved = structuredClone(original);
  const first = mergeHudHooks(original, template, helper);
  assert.deepEqual(original, saved);
  assert.deepEqual(first.settings.permissions, saved.permissions);
  assert.deepEqual(first.settings.hooks.PreToolUse[0], saved.hooks.PreToolUse[0]);
  assert.deepEqual(first.settings.hooks.StopFailure, []);
  assert.equal(first.added.length, 9);
  const second = mergeHudHooks(first.settings, template, helper);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.settings, first.settings);
});
test('rejects malformed structures without guessing a replacement', () => {
  for (const value of [null, [], { hooks: [] }, { hooks: { PreToolUse: null } }, { hooks: { PreToolUse: {} } }, { hooks: { PreToolUse: [{}] } }]) assert.throws(() => mergeHudHooks(value, template, helper));
});
test('backs up exact bytes and preserves BOM/CRLF before atomically merging', () => {
  assert.ok(process.env.PI_SCRATCH_DIR, 'Tests require an explicit scratch directory');
  const root = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, 'hook-config-test-'));
  try {
    const settingsPath = path.join(root, 'settings.json');
    const helperPath = path.join(root, 'agent-hud-hook.exe');
    fs.writeFileSync(helperPath, 'fixture');
    const original = Buffer.from('\uFEFF{\r\n  "permissions": {"allow": ["Read"]}\r\n}\r\n');
    fs.writeFileSync(settingsPath, original);
    const result = configure(settingsPath, helperPath, root);
    assert.ok(fs.readFileSync(result.backup).equals(original));
    const updated = fs.readFileSync(settingsPath, 'utf8');
    assert.ok(updated.startsWith('\uFEFF'));
    assert.ok(updated.includes('\r\n'));
    assert.deepEqual(JSON.parse(updated.slice(1)).permissions, { allow: ['Read'] });
    assert.deepEqual(configure(settingsPath, helperPath, root), { added: [], backup: null });
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('an existing narrow matcher does not suppress the all-tools Hook', () => {
  const narrow = { matcher: 'Bash', hooks: [{ type: 'command', command: `"${helper}"` }] };
  const result = mergeHudHooks({ hooks: { PreToolUse: [narrow] } }, template, helper);
  assert.deepEqual(result.settings.hooks.PreToolUse[0], narrow);
  assert.equal(result.settings.hooks.PreToolUse[1].matcher, '.*');
  assert.deepEqual(mergeHudHooks(result.settings, template, helper).added, []);
});
