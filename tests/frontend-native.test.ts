import { describe, expect, it, vi } from 'vitest';
import { openHudConnection, type HudPort } from '../src/native';
import type { Snapshot } from '../src/model';

const empty: Snapshot = { sessions: [], collectors: [] };
function makePort() {
  const unlistenSnapshot = vi.fn();
  const unlistenInteraction = vi.fn();
  const order: string[] = [];
  const port: HudPort = {
    snapshots: vi.fn(async () => { order.push('snapshot listener'); return unlistenSnapshot; }),
    interactions: vi.fn(async () => { order.push('interaction listener'); return unlistenInteraction; }),
    privacy: vi.fn(async () => { order.push('privacy'); }),
    snapshot: vi.fn(async () => { order.push('get_snapshot'); return empty; }),
  };
  return { port, order, unlistenSnapshot, unlistenInteraction };
}

describe('native subscription lifecycle', () => {
  it('registers both listeners before invoke, and removes both on close', async () => {
    const { port, order, unlistenSnapshot, unlistenInteraction } = makePort();
    const onSnapshot = vi.fn();
    const connection = openHudConnection(port, onSnapshot, vi.fn(), false);
    await connection.ready;
    expect(order).toEqual(['snapshot listener', 'interaction listener', 'privacy', 'get_snapshot']);
    expect(onSnapshot).toHaveBeenCalledWith(empty);
    await connection.close();
    await connection.close();
    expect(unlistenSnapshot).toHaveBeenCalledTimes(1);
    expect(unlistenInteraction).toHaveBeenCalledTimes(1);
  });
  it('propagates actual native failures and cleans partial listener registration', async () => {
    const { port, unlistenSnapshot } = makePort();
    port.interactions = vi.fn(async () => { throw new Error('Event registration denied'); });
    const connection = openHudConnection(port, vi.fn(), vi.fn(), false);
    await expect(connection.ready).rejects.toThrow('Event registration denied');
    expect(unlistenSnapshot).toHaveBeenCalledOnce();
    expect(port.snapshot).not.toHaveBeenCalled();
  });
  it('cleans a listener whose promise resolves after unmount without invoking initial commands', async () => {
    const { port } = makePort();
    let resolveListener!: (unlisten: () => void) => void;
    port.snapshots = () => new Promise(resolve => { resolveListener = resolve; });
    const unlisten = vi.fn();
    const connection = openHudConnection(port, vi.fn(), vi.fn(), false);
    await connection.close();
    resolveListener(unlisten);
    await connection.ready;
    expect(unlisten).toHaveBeenCalledOnce();
    expect(port.interactions).not.toHaveBeenCalled();
    expect(port.snapshot).not.toHaveBeenCalled();
  });
  it('does not overwrite a newer pushed snapshot with a stale invoke response', async () => {
    const { port } = makePort();
    let push!: (snapshot: Snapshot) => void;
    port.snapshots = vi.fn(async handler => { push = handler; return vi.fn(); });
    const newer: Snapshot = { ...empty, collectors: [{ agent: 'claude', state: 'watching', message: 'newer' }] };
    port.snapshot = vi.fn(async () => { push(newer); return empty; });
    const onSnapshot = vi.fn();
    const connection = openHudConnection(port, onSnapshot, vi.fn(), true);
    await connection.ready;
    expect(port.privacy).toHaveBeenCalledWith(true);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(newer);
    await connection.close();
  });
  it('forwards temporary interaction and ignores pushes after disposal', async () => {
    const { port } = makePort();
    let push!: (snapshot: Snapshot) => void;
    let interact!: (interactive: boolean) => void;
    port.snapshots = async handler => { push = handler; return vi.fn<() => void>(); };
    port.interactions = async handler => { interact = handler; return vi.fn<() => void>(); };
    const onSnapshot = vi.fn();
    const onInteraction = vi.fn();
    const connection = openHudConnection(port, onSnapshot, onInteraction, false);
    await connection.ready;
    interact(true);
    expect(onInteraction).toHaveBeenCalledWith(true);
    await connection.close();
    onSnapshot.mockClear();
    onInteraction.mockClear();
    push(empty);
    interact(false);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onInteraction).not.toHaveBeenCalled();
  });
  it('surfaces asynchronous unlisten IPC failures instead of discarding their promises', async () => {
    const { port } = makePort();
    port.snapshots = async () => async () => { throw new Error('Unlisten denied'); };
    const connection = openHudConnection(port, vi.fn(), vi.fn(), false);
    await connection.ready;
    await expect(connection.close()).rejects.toThrow('Unlisten denied');
  });
});
