const fs = require('node:fs');
const path = require('node:path');
const { writeSettings } = require('./configure-claude-hooks.cjs');

function removeHudHooks(settings, helper) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude settings must be an object');
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error('Claude hooks must be an object');
  const next = structuredClone(settings);
  const removed = [];
  if (next.hooks === undefined) return { settings: next, removed };
  const command = `"${helper.replaceAll('\\', '/')}"`;
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries) || entries.some(entry => !entry || !Array.isArray(entry.hooks))) throw new Error(`Unsupported Hook structure: ${event}`);
    let changed = false;
    const groups = entries.flatMap(entry => {
      const hooks = entry.hooks.filter(hook => !(hook && hook.type === 'command' && hook.command === command));
      if (hooks.length === entry.hooks.length) return [entry];
      changed = true;
      return hooks.length === 0 ? [] : [{ ...entry, hooks }];
    });
    if (!changed) continue;
    removed.push(event);
    if (groups.length === 0) delete next.hooks[event];
    else next.hooks[event] = groups;
  }
  return { settings: next, removed };
}

function unconfigure(settingsPath, helperPath, backupDirectory) {
  for (const value of [settingsPath, helperPath, backupDirectory]) if (!path.isAbsolute(value)) throw new Error('All paths must be absolute');
  const original = fs.readFileSync(settingsPath);
  const text = original.toString('utf8');
  const bomLength = text.startsWith('\uFEFF') ? 1 : 0;
  const result = removeHudHooks(JSON.parse(text.slice(bomLength)), helperPath);
  if (result.removed.length === 0) return { removed: [], backup: null };
  return { removed: result.removed, backup: writeSettings(settingsPath, backupDirectory, original, result.settings) };
}

module.exports = { removeHudHooks, unconfigure };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error('Usage: node scripts/unconfigure-claude-hooks.cjs <absolute-settings-path> <absolute-helper-path> <absolute-backup-directory>');
    console.log(JSON.stringify(unconfigure(...args)));
  } catch (error) {
    console.error(`HUD Hook removal: ${error.message}`);
    process.exitCode = 1;
  }
}
