import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Snapshot } from './model';

export interface HudPort {
  snapshots: (handler: (snapshot: Snapshot) => void) => Promise<UnlistenFn>;
  interactions: (handler: (interactive: boolean) => void) => Promise<UnlistenFn>;
  privacy: (showCommandDetail: boolean) => Promise<void>;
  snapshot: () => Promise<Snapshot>;
}

export const tauriPort: HudPort = {
  snapshots: handler => listen<Snapshot>('hud:snapshot', event => handler(event.payload)),
  interactions: handler => listen<boolean>('hud:interaction', event => handler(event.payload)),
  privacy: showCommandDetail => invoke('set_privacy', { showCommandDetail }),
  snapshot: () => invoke<Snapshot>('get_snapshot'),
};

export function openHudConnection(
  port: HudPort, onSnapshot: (snapshot: Snapshot) => void,
  onInteraction: (interactive: boolean) => void, showCommandDetail: boolean,
): { ready: Promise<void>; close: () => Promise<void> } {
  let closed = false;
  let revision = 0;
  const unlisteners: UnlistenFn[] = [];
  const close = async () => {
    closed = true;
    // Tauri types this callback as void, but its implementation returns an IPC promise.
    await Promise.all(unlisteners.splice(0).map(async unlisten => { await unlisten(); }));
  };
  const register = async (unlisten: UnlistenFn) => {
    if (closed) { await unlisten(); return false; }
    unlisteners.push(unlisten);
    return true;
  };
  const ready = (async () => {
    try {
      if (!await register(await port.snapshots(snapshot => {
        if (!closed) { revision += 1; onSnapshot(snapshot); }
      }))) return;
      if (!await register(await port.interactions(interactive => {
        if (!closed) onInteraction(interactive);
      }))) return;
      // Both listeners precede all initial commands, including the privacy-aware snapshot.
      await port.privacy(showCommandDetail);
      if (closed) return;
      const beforeRequest = revision;
      const initial = await port.snapshot();
      // A push received while invoke was in flight is newer than the initial snapshot.
      if (!closed && revision === beforeRequest) onSnapshot(initial);
    } catch (error) {
      try { await close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native 连接与 listener 清理均失败'); }
      throw error;
    }
  })();
  return { ready, close };
}
