/**
 * The generated bridge's result store, run for real in a VM context with a
 * fake runtime and a fake clock: a command can be withdrawn before it runs
 * (cancel), and results nobody collects expire instead of piling up.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { generateBridgeScript } from '../../src/runtime/bridge.js';

interface Bridge {
  submit(type: string, args: Record<string, unknown>): number;
  getResult(id: number): { ok: boolean; value?: unknown; error?: string } | null;
  cancel(id: number): 'queued' | 'result' | false;
  _results: Record<string, unknown>;
}

interface Harness {
  bridge: Bridge;
  runtime: { globalVars: Record<string, unknown> };
  tick(): void;
  advance(ms: number): void;
}

async function boot(): Promise<Harness> {
  let startup: ((runtime: unknown) => Promise<void>) | undefined;
  const listeners: Array<() => void> = [];
  let now = 1_000_000;
  const clock = { now: () => now };
  const runtime = {
    globalVars: { Score: 0 } as Record<string, unknown>,
    layout: { name: 'Title' },
    tickCount: 0,
    gameTime: 0,
    objects: {},
    addEventListener(type: string, fn: () => void) { if (type === 'tick') listeners.push(fn); },
  };
  const context = createContext({ runOnStartup: (fn: (runtime: unknown) => Promise<void>) => { startup = fn; }, console, Date: clock, Map, Object, Number, Error });
  runInContext(generateBridgeScript(), context);
  await startup!(runtime);
  return {
    bridge: (context as unknown as { __c3bridge: Bridge }).__c3bridge,
    runtime,
    tick: () => { runtime.tickCount++; for (const fn of listeners) fn(); },
    advance: (ms) => { now += ms; },
  };
}

let h: Harness;
beforeEach(async () => { h = await boot(); });

describe('cancel', () => {
  it('withdraws a queued command so it never runs', () => {
    const id = h.bridge.submit('setGlobalVar', { name: 'Score', value: 99 });
    expect(h.bridge.cancel(id)).toBe('queued');
    h.tick();
    expect(h.runtime.globalVars.Score).toBe(0);
    expect(h.bridge.getResult(id)).toBeNull();
  });

  it('discards the result of a command that already ran, and knows no other id', () => {
    const id = h.bridge.submit('ping', {});
    h.tick();
    expect(h.bridge.cancel(id)).toBe('result');
    expect(h.bridge.getResult(id)).toBeNull();
    expect(h.bridge.cancel(id)).toBe(false);
    expect(h.bridge.cancel(123456)).toBe(false);
  });
});

describe('result expiry', () => {
  it('drops results nobody collected within 60 s, and keeps younger ones', () => {
    const old = h.bridge.submit('ping', {});
    h.tick();
    h.advance(30_000);
    const young = h.bridge.submit('ping', {});
    h.tick();
    h.advance(31_000);
    h.tick();
    expect(h.bridge.getResult(old)).toBeNull();
    expect(h.bridge.getResult(young)).toMatchObject({ ok: true });
    expect(Object.keys(h.bridge._results)).toEqual([]);
  });
});
