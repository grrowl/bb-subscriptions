import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import plugin from './server';
import { canonical, describe as transition, type Snapshot } from './model';
import { fetchSnapshot, ProviderError } from './providers';
vi.mock('./providers', async original => ({ ...await original<typeof import('./providers')>(), fetchSnapshot: vi.fn() }));
const snapshot: Snapshot = { title: 'Example', url: 'https://github.com/o/r/pull/1', state: 'open', updatedAt: '2026-01-01', fields: { checks: 'pending' } };
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
function host() {
  const result = createFakePluginHost({ pluginId: 'subscriptions', sdk: { threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }), send: async () => ({ status: 'sent' } as never) } } });
  hosts.push(result); plugin(result.bb); return result;
}
async function cycle(h: ReturnType<typeof host>, check: () => void) {
  const service = h.harness.behavior.runService('watch');
  try { await vi.waitFor(check, { timeout: 3000, interval: 10 }); }
  finally { service.controller.abort(); await service.done; }
}
async function due(h: ReturnType<typeof host>) { const current: any = await h.harness.behavior.callRpc('list', { threadId: 't1' }); await h.harness.behavior.setSettings({ intervalSeconds: current.intervalSeconds === 60 ? 61 : 60 }); }
const input = { threadId: 't1', platform: 'github', ids: ['o/r#1'] };
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose(); vi.restoreAllMocks(); vi.mocked(fetchSnapshot).mockReset(); });
describe('IDs and summaries', () => {
  it('normalizes URLs, defaults and provider casing', () => {
    expect(canonical('github', 'https://github.com/O/R/pull/12/files')).toBe('o/r#12');
    expect(canonical('github', '12', 'O/R')).toBe('o/r#12');
    expect(canonical('linear', 'https://linear.app/acme/issue/eng-12/title')).toBe('ENG-12');
    expect(() => canonical('github', 'https://evil.test/o/r/pull/1')).toThrow();
    expect(() => canonical('github', '1')).toThrow();
    expect(() => canonical('linear', '--help')).toThrow();
  });
  it('describes state/check changes without repeating identical snapshots', () => {
    expect(transition('o/r#1', snapshot, snapshot)).toBeNull();
    expect(transition('o/r#1', snapshot, { ...snapshot, state: 'merged', fields: { checks: 'success' } })).toContain('open → merged; checks: pending → success');
  });
});
it('bulk operations are scoped, idempotent, and reject invalid batches atomically', async () => {
  const h = host();
  await h.harness.behavior.callRpc('subscribe', { ...input, ids: ['O/R#1', 'o/r#1', 'o/r#2'] });
  await h.harness.behavior.callRpc('subscribe', { ...input, threadId: 't2' });
  await expect(h.harness.behavior.callRpc('subscribe', { ...input, ids: ['o/r#3', 'bad'] })).rejects.toThrow();
  expect((await h.harness.behavior.callRpc('list', { threadId: 't1' }) as any).subscriptions).toHaveLength(2);
  await h.harness.behavior.callRpc('unsubscribe', { ...input, ids: ['o/r#1', 'o/r#2'] });
  expect((await h.harness.behavior.callRpc('list', { threadId: 't1' }) as any).subscriptions).toHaveLength(0);
  expect((await h.harness.behavior.callRpc('list', { threadId: 't2' }) as any).subscriptions).toHaveLength(1);
});
it('sets a silent baseline, wakes on changes, and does not repeat unchanged updates', async () => {
  const h = host(); vi.mocked(fetchSnapshot).mockResolvedValue(snapshot);
  await h.harness.behavior.callRpc('subscribe', input);
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  vi.mocked(fetchSnapshot).mockResolvedValue({ ...snapshot, state: 'merged' }); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
  await due(h); await cycle(h, () => expect(vi.mocked(fetchSnapshot)).toHaveBeenCalledTimes(3));
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
});
it('preserves baseline on delivery failure and retries without losing the change', async () => {
  const h = host(); vi.mocked(fetchSnapshot).mockResolvedValue(snapshot);
  await h.harness.behavior.callRpc('subscribe', input);
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  h.harness.sdk.stub('threads.send', async () => { throw new Error('offline'); });
  vi.mocked(fetchSnapshot).mockResolvedValue({ ...snapshot, state: 'closed' }); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
  const failed: any = await h.harness.behavior.callRpc('list', { threadId: 't1' });
  expect(failed.subscriptions[0].snapshot.state).toBe('open'); expect(failed.subscriptions[0].error).toContain('retry');
  h.harness.sdk.stub('threads.send', async () => ({ status: 'sent' } as never)); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(2));
  expect((await h.harness.behavior.callRpc('list', { threadId: 't1' }) as any).subscriptions[0].snapshot.state).toBe('closed');
});
it('unsubscribing during an in-flight fetch prevents delivery', async () => {
  const h = host(); vi.mocked(fetchSnapshot).mockResolvedValue(snapshot);
  await h.harness.behavior.callRpc('subscribe', input); await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  let resolve!: (s: Snapshot) => void;
  vi.mocked(fetchSnapshot).mockImplementation(() => new Promise(r => { resolve = r; })); await due(h);
  const service = h.harness.behavior.runService('watch');
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await h.harness.behavior.callRpc('unsubscribe', input); resolve({ ...snapshot, state: 'merged' });
  await new Promise(r => setTimeout(r, 30)); service.controller.abort(); await service.done;
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
});
it('shares lookups across threads and pauses archived threads', async () => {
  const h = host(); vi.mocked(fetchSnapshot).mockResolvedValue(snapshot);
  await h.harness.behavior.callRpc('subscribe', input); await h.harness.behavior.callRpc('subscribe', { ...input, threadId: 't2' });
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(4));
  expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  h.harness.sdk.stub('threads.get', async ({ threadId }) => makeThreadResponse({ id: threadId, archivedAt: 100 })); await due(h);
  const service = h.harness.behavior.runService('watch'); await new Promise(r => setTimeout(r, 30)); service.controller.abort(); await service.done;
  expect(fetchSnapshot).toHaveBeenCalledTimes(1);
});
it('keeps subscriptions over reload and removes them when a thread is deleted', async () => {
  let h = host(); await h.harness.behavior.callRpc('subscribe', input);
  const replacement = await h.harness.lifecycle.reload(plugin);
  hosts.splice(hosts.indexOf(h), 1, replacement); h = replacement;
  expect((await h.harness.behavior.callRpc('list', { threadId: 't1' }) as any).subscriptions).toHaveLength(1);
  await h.harness.behavior.emitThreadEvent('thread.deleted', { thread: makeThreadResponse({ id: 't1' }) });
  expect((await h.harness.behavior.callRpc('list', { threadId: 't1' }) as any).subscriptions).toHaveLength(0);
});
it('surfaces provider failures without messages and observes retry backoff', async () => {
  const h = host(); vi.mocked(fetchSnapshot).mockRejectedValue(new ProviderError('Rate limited', 900_000));
  await h.harness.behavior.callRpc('subscribe', input); await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  const result: any = await h.harness.behavior.callRpc('list', { threadId: 't1' });
  expect(result.subscriptions[0].error).toBe('Rate limited');
  const service = h.harness.behavior.runService('watch'); await new Promise(r => setTimeout(r, 30)); service.controller.abort(); await service.done;
  expect(fetchSnapshot).toHaveBeenCalledTimes(1); expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
});
it('supports bulk CLI aliases, explicit thread scope and errors', async () => {
  const h = host();
  expect((await h.harness.behavior.runCli(['sub', 'linear', 'ENG-1,ENG-2', '--thread', 't1'])).exitCode).toBe(0);
  const result = await h.harness.behavior.runCli(['list', '--thread', 't1', '--json']);
  expect(JSON.parse(result.stdout!).subscriptions).toHaveLength(2);
  expect((await h.harness.behavior.runCli(['unsub', 'linear', 'ENG-1', 'ENG-2', '--thread', 't1'])).exitCode).toBe(0);
  expect((await h.harness.behavior.runCli(['sub', 'github', 'o/r#1', '--thread'])).exitCode).toBe(1);
});
it('uses public SDK imports only', async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^react$/, /^vitest$/, /^@testing-library\/react$/] });
  expect(result.violations).toEqual([]); expect(result.privateDependencies).toEqual([]);
});
