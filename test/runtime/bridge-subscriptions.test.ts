/**
 * Event subscriptions in the generated bridge (roadmap B2, upstream issue 11),
 * run for real: the generated script is evaluated in a fresh VM context
 * whose runOnStartup captures the startup callback, a fake documented
 * runtime (globalVars, layout, tickCount, gameTime, addEventListener) is
 * supplied, and ticks are fired by hand.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { generateBridgeScript } from '../../src/runtime/bridge.js';

interface Bridge {
  subscribe(eventType: string, filter?: Record<string, unknown>, bufferSize?: number): string;
  readEvents(id: string, clear?: boolean): Array<Record<string, unknown>>;
  unsubscribe(id: string): boolean;
  emit(name: string, data: unknown): number;
  submit(type: string, args: Record<string, unknown>): number;
  getResult(id: number): { ok: boolean; value?: unknown; error?: string } | null;
}

interface Harness {
  bridge: Bridge;
  runtime: { globalVars: Record<string, unknown>; layout: { name: string }; tickCount: number; gameTime: number };
  tick(times?: number): void;
  /** Submit a command and run one tick, returning its result. */
  command(type: string, args?: Record<string, unknown>): { ok: boolean; value?: unknown; error?: string };
}

async function boot(): Promise<Harness> {
  let startup: ((runtime: unknown) => Promise<void>) | undefined;
  const listeners: Array<() => void> = [];
  const runtime = {
    globalVars: { Score: 0, Name: 'a' } as Record<string, unknown>,
    layout: { name: 'Title' },
    tickCount: 0,
    gameTime: 0,
    addEventListener(type: string, fn: () => void) { if (type === 'tick') listeners.push(fn); },
  };
  const context = createContext({ runOnStartup: (fn: (runtime: unknown) => Promise<void>) => { startup = fn; }, console, Date, Map, Object, Number, Error });
  runInContext(generateBridgeScript(), context);
  await startup!(runtime);
  const bridge = (context as unknown as { __c3bridge: Bridge }).__c3bridge;
  const tick = (times = 1) => { for (let i = 0; i < times; i++) { runtime.tickCount++; runtime.gameTime += 1 / 60; for (const fn of listeners) fn(); } };
  return {
    bridge,
    runtime,
    tick,
    command(type, args = {}) { const id = bridge.submit(type, args); tick(); return bridge.getResult(id)!; },
  };
}

let h: Harness;
beforeEach(async () => { h = await boot(); });

describe('global variable subscriptions', () => {
  it('does not emit the initial value, emits one ordered event per change, and stays quiet on unchanged ticks', () => {
    const id = h.bridge.subscribe('globalVarChange', { variable: 'Score' });
    h.tick(3);
    expect(h.bridge.readEvents(id)).toEqual([]);
    h.runtime.globalVars.Score = 5;
    h.tick();
    h.tick();
    h.runtime.globalVars.Score = 7;
    h.tick();
    const events = h.bridge.readEvents(id);
    expect(events.map(e => [e.type, e.name, e.value, e.previousValue, e.tick])).toEqual([
      ['globalVarChange', 'Score', 5, 0, 4],
      ['globalVarChange', 'Score', 7, 5, 6],
    ]);
    expect(typeof events[0].timestamp).toBe('number');
    expect(h.bridge.readEvents(id)).toEqual([]);
  });

  it('refuses an unknown variable, a missing filter, an unknown event type and a bad buffer size', () => {
    expect(() => h.bridge.subscribe('globalVarChange', { variable: 'Nope' })).toThrow('Unknown global variable: Nope');
    expect(() => h.bridge.subscribe('globalVarChange', {})).toThrow('globalVarChange needs filter.variable');
    expect(() => h.bridge.subscribe('signal', {})).toThrow('Unknown event type: signal');
    expect(() => h.bridge.subscribe('custom', {}, 0)).toThrow('bufferSize must be an integer from 1 to 1000');
    expect(() => h.bridge.subscribe('custom', {}, 1001)).toThrow('bufferSize must be an integer from 1 to 1000');
    expect(() => h.bridge.subscribe('custom', {}, 2.5)).toThrow('bufferSize must be an integer from 1 to 1000');
    expect(() => h.bridge.readEvents('sub-99')).toThrow('Unknown subscription: sub-99');
  });
});

describe('layout and custom subscriptions', () => {
  it('reports a layout change with the old and new names', () => {
    const id = h.bridge.subscribe('layoutChange');
    h.tick();
    h.runtime.layout = { name: 'Game' };
    h.tick();
    expect(h.bridge.readEvents(id)).toEqual([expect.objectContaining({ type: 'layoutChange', name: 'Game', value: 'Game', previousValue: 'Title', tick: 2 })]);
  });

  it('delivers custom events to matching subscriptions only, with independent buffers', () => {
    const all = h.bridge.subscribe('custom');
    const bonus = h.bridge.subscribe('custom', { name: 'bonus' });
    expect(h.bridge.emit('bonus', { pot: 3 })).toBe(2);
    expect(h.bridge.emit('spin', 1)).toBe(1);
    expect(h.bridge.readEvents(all).map(e => [e.name, e.value])).toEqual([['bonus', { pot: 3 }], ['spin', 1]]);
    expect(h.bridge.readEvents(bonus).map(e => [e.name, e.value])).toEqual([['bonus', { pot: 3 }]]);
    expect(h.bridge.readEvents(bonus)).toEqual([]);
  });
});

describe('buffers', () => {
  it('drops the oldest event when full, and clear false preserves while clear true empties', () => {
    const id = h.bridge.subscribe('custom', {}, 3);
    for (let i = 1; i <= 5; i++) h.bridge.emit('n', i);
    expect(h.bridge.readEvents(id, false).map(e => e.value)).toEqual([3, 4, 5]);
    expect(h.bridge.readEvents(id, false).map(e => e.value)).toEqual([3, 4, 5]);
    expect(h.bridge.readEvents(id, true).map(e => e.value)).toEqual([3, 4, 5]);
    expect(h.bridge.readEvents(id)).toEqual([]);
  });

  it('unsubscribe stops delivery, releases the state, and reports whether an entry existed', () => {
    const id = h.bridge.subscribe('globalVarChange', { variable: 'Score' });
    expect(h.bridge.unsubscribe(id)).toBe(true);
    expect(h.bridge.unsubscribe(id)).toBe(false);
    h.runtime.globalVars.Score = 9;
    h.tick();
    expect(() => h.bridge.readEvents(id)).toThrow('Unknown subscription: sub-1');
  });
});

describe('through the command queue', () => {
  it('runs commands before polling, so a subscription made this tick starts observing on the next', () => {
    h.runtime.globalVars.Score = 1;
    const made = h.command('subscribeEvents', { eventType: 'globalVarChange', filter: { variable: 'Score' } });
    expect(made).toEqual({ ok: true, value: { subscription_id: 'sub-1' } });
    expect(h.command('readEvents', { subscriptionId: 'sub-1' })).toEqual({ ok: true, value: { events: [], count: 0 } });
    h.runtime.globalVars.Score = 2;
    const read = h.command('readEvents', { subscriptionId: 'sub-1', clear: false });
    // The change is seen by the poll of the tick that ran the read command, after it.
    expect(read.value).toEqual({ events: [], count: 0 });
    const again = h.command('readEvents', { subscriptionId: 'sub-1' });
    expect((again.value as { count: number }).count).toBe(1);
    expect(h.command('unsubscribeEvents', { subscriptionId: 'sub-1' })).toEqual({ ok: true, value: { subscription_id: 'sub-1', unsubscribed: true } });
    expect(h.command('unsubscribeEvents', { subscriptionId: 'sub-1' })).toEqual({ ok: true, value: { error: 'Unknown subscription: sub-1' } });
    const bad = h.command('subscribeEvents', { eventType: 'globalVarChange', filter: {} });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('globalVarChange needs filter.variable');
  });
});
