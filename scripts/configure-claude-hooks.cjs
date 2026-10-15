const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function mergeHudHooks(settings, template, helper) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude settings must be an object');
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Claude hooks must be an object');
  const next = structuredClone(settings);
  next.hooks ??= {};
  const command = `"${helper.replaceAll('\\', '/')}"`;
  const added = [];
  for (const [event, entries] of Object.entries(template.hooks)) {
    const existing = Object.hasOwn(next.hooks, event) ? next.hooks[event] : [];
    if (!Array.isArray(existing) || existing.some(entry => !entry || !Array.isArray(entry.hooks))) throw new Error(`Unsupported Hook structure: ${event}`);
    if (existing.some(entry => entry.matcher === entries[0].matcher && entry.hooks.some(hook => hook.type === 'command' && hook.command === command))) continue;
    next.hooks[event] = [...existing, ...entries.map(entry => ({ ...entry, hooks: entry.hooks.map(hook => ({ ...hook, command })) }))];
    added.push(event);
  }
  return { settings: next, added };
}

function configure(settingsPath, helperPath, backupDirectory) {
  for (const value of [settingsPath, helperPath, backupDirectory]) if (!path.isAbsolute(value)) throw new Error('All paths must be absolute');
  if (!fs.statSync(helperPath).isFile()) throw new Error('Hook helper must be an existing file');
  const original = fs.readFileSync(settingsPath);
  const text = original.toString('utf8');
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/claude-hooks.example.json'), 'utf8'));
  const result = mergeHudHooks(JSON.parse(text.slice(bom.length)), template, helperPath);
  if (result.added.length === 0) return { added: [], backup: null };
  fs.mkdirSync(backupDirectory, { recursive: true });
  const suffix = crypto.randomUUID();
  const backup = path.join(backupDirectory, `claude-settings-before-hud-${suffix}.json`);
  fs.writeFileSync(backup, original, { flag: 'wx' });
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? '  ';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const serialized = bom + JSON.stringify(result.settings, null, indent).replaceAll('\n', newline) + newline;
  const pending = `${settingsPath}.hud-${suffix}.pending`;
  try {
    fs.writeFileSync(pending, serialized, { flag: 'wx' });
    if (!fs.readFileSync(settingsPath).equals(original)) throw new Error('Claude settings changed during merge; original config was not overwritten');
    fs.renameSync(pending, settingsPath);
  } finally {
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
  }
  return { added: result.added, backup };
}

module.exports = { mergeHudHooks, configure };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error('Usage: node scripts/configure-claude-hooks.cjs <absolute-settings-path> <absolute-helper-path> <absolute-backup-directory>');
    console.log(JSON.stringify(configure(...args)));
  } catch (error) {
    console.error(`HUD Hook configuration: ${error.message}`);
    process.exitCode = 1;
  }
}
