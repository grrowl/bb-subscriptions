import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeQueueEntry, makeThreadResponse, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import plugin from './server';
import { describe as transition, type Snapshot } from './model';
import { fetchBatch, githubRepositoryFromRemote, provider, ProviderError } from './providers';
vi.mock('./providers', async original => ({ ...await original<typeof import('./providers')>(), fetchBatch: vi.fn() }));
const canonical = (platform: string, raw: string, repository = '') => provider(platform).canonical(raw, { config: {}, repository });
/** Every id in the batch resolves to `value` (a snapshot or a ProviderError). */
const resolveAll = (value: Snapshot | ProviderError) => vi.mocked(fetchBatch).mockImplementation(async (_platform, ids) => ({ items: new Map(ids.map(id => [id, value])) }));
const snapshot: Snapshot = { title: 'Example', url: 'https://github.com/o/r/pull/1', state: 'open', updatedAt: '2026-01-01', fields: { checks: 'pending' } };
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
function host() {
  const result = createFakePluginHost({ pluginId: 'subscriptions', sdk: { threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId }), send: async () => ({ delivery: 'sent', ok: true } as never) }, projects: { get: async () => ({ id: 'project-1', name: 'Stage 1', kind: 'standard', gitRemoteUrl: 'git@github.com:Levercon/stage-1.git', createdAt: 0, updatedAt: 0 }) } } });
  hosts.push(result); plugin(result.bb); return result;
}
async function cycle(h: ReturnType<typeof host>, check: () => void, timeout = 3000) {
  const service = h.harness.behavior.runService('watch');
  try { await vi.waitFor(check, { timeout, interval: 10 }); }
  finally { service.controller.abort(); await service.done; }
}
async function due(h: ReturnType<typeof host>) { const current: any = await h.harness.behavior.callRpc('list', { threadId: 't1' }); await h.harness.behavior.setSettings({ debounceSeconds: 0, intervalSeconds: current.intervalSeconds === 60 ? 61 : 60 }); }
const sentText = (h: ReturnType<typeof host>, n = 0) => (h.harness.inspection.sdk.callsTo('threads.send')[n][0] as any).input[0].text as string;
const input = { threadId: 't1', platform: 'github', ids: ['o/r#1'] };
const db = (h: ReturnType<typeof host>) => h.bb.storage.database();
afterEach(async () => { for (const h of hosts.splice(0)) await h.harness.lifecycle.dispose(); vi.restoreAllMocks(); vi.mocked(fetchBatch).mockReset(); });
describe('IDs and summaries', () => {
  it('normalizes URLs, defaults and provider casing', () => {
    expect(canonical('github', 'https://github.com/O/R/pull/12/files')).toBe('o/r#12');
    expect(canonical('github', '12', 'O/R')).toBe('o/r#12');
    expect(canonical('linear', 'https://linear.app/acme/issue/eng-12/title')).toBe('ENG-12');
    expect(githubRepositoryFromRemote('git@github.com:Levercon/stage-1.git')).toBe('levercon/stage-1');
    expect(githubRepositoryFromRemote('https://github.com/Levercon/stage-1/')).toBe('levercon/stage-1');
    expect(() => canonical('github', 'https://evil.test/o/r/pull/1')).toThrow();
    expect(() => canonical('github', '1')).toThrow();
    expect(() => canonical('linear', '--help')).toThrow();
  });
  it('describes state/check changes without repeating identical snapshots', () => {
    expect(transition('o/r#1', snapshot, snapshot)).toBeNull();
    expect(transition('o/r#1', snapshot, { ...snapshot, state: 'merged', fields: { checks: 'success' } })).toBe('[o/r#1](https://github.com/o/r/pull/1): open → merged; checks: pending → success.');
    expect(transition('o/r#1', snapshot, { ...snapshot, updatedAt: '2026-02-02' })).toBeNull();
  });
});
it('infers a GitHub repository from the subscribing thread project for bare PR numbers', async () => {
  const h = host();
  const result: any = await h.harness.behavior.callRpc('subscribe', { threadId: 't1', platform: 'github', ids: ['480', '#481'] });
  expect(result.ids).toEqual(['levercon/stage-1#480', 'levercon/stage-1#481']);
  expect(h.harness.inspection.sdk.callsTo('projects.get')).toHaveLength(1);
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
  const h = host(); resolveAll(snapshot);
  await h.harness.behavior.callRpc('subscribe', input);
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
  resolveAll({ ...snapshot, state: 'merged' }); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
  await due(h); await cycle(h, () => expect(vi.mocked(fetchBatch)).toHaveBeenCalledTimes(3));
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
});
it('preserves baseline on delivery failure and retries without losing the change', async () => {
  const h = host(); resolveAll(snapshot);
  await h.harness.behavior.callRpc('subscribe', input);
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  h.harness.sdk.stub('threads.send', async () => { throw new Error('offline'); });
  resolveAll({ ...snapshot, state: 'closed' }); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
  // The snapshot advances; the unsent change is held with its pre-change baseline and retried.
  expect((await h.harness.behavior.callRpc('list', { threadId: 't1' }) as any).subscriptions[0].snapshot.state).toBe('closed');
  h.harness.sdk.stub('threads.send', async () => ({ delivery: 'sent', ok: true } as never));
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(2), 8000);
  expect(sentText(h, 1)).toBe('[Subscription update] [o/r#1](https://github.com/o/r/pull/1): open → closed.');
  // Nothing further to say once it is delivered.
  await due(h); await cycle(h, () => expect(vi.mocked(fetchBatch).mock.calls.length).toBeGreaterThan(2));
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(2);
}, 15_000);
it('unsubscribing during an in-flight fetch prevents delivery', async () => {
  const h = host(); resolveAll(snapshot);
  await h.harness.behavior.callRpc('subscribe', input); await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  let resolve!: (s: Snapshot) => void;
  vi.mocked(fetchBatch).mockImplementation((_p, ids) => new Promise(r => { resolve = s => r({ items: new Map(ids.map(id => [id, s])) }); })); await due(h);
  const service = h.harness.behavior.runService('watch');
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await h.harness.behavior.callRpc('unsubscribe', input); resolve({ ...snapshot, state: 'merged' });
  await new Promise(r => setTimeout(r, 30)); service.controller.abort(); await service.done;
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
});
it('shares lookups across threads and pauses archived threads', async () => {
  const h = host(); resolveAll(snapshot);
  await h.harness.behavior.callRpc('subscribe', input); await h.harness.behavior.callRpc('subscribe', { ...input, threadId: 't2' });
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(4));
  expect(fetchBatch).toHaveBeenCalledTimes(1);
  h.harness.sdk.stub('threads.get', async ({ threadId }) => makeThreadResponse({ id: threadId, archivedAt: 100 })); await due(h);
  const service = h.harness.behavior.runService('watch'); await new Promise(r => setTimeout(r, 30)); service.controller.abort(); await service.done;
  expect(fetchBatch).toHaveBeenCalledTimes(1);
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
  const h = host(); resolveAll(new ProviderError('Rate limited', 900_000));
  await h.harness.behavior.callRpc('subscribe', input); await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  const result: any = await h.harness.behavior.callRpc('list', { threadId: 't1' });
  expect(result.subscriptions[0].error).toBe('Rate limited');
  const service = h.harness.behavior.runService('watch'); await new Promise(r => setTimeout(r, 30)); service.controller.abort(); await service.done;
  expect(fetchBatch).toHaveBeenCalledTimes(1); expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(0);
});
it('batches one lookup per platform per sweep and pauses a provider after a rate limit', async () => {
  const h = host();
  vi.mocked(fetchBatch).mockImplementation(async (_platform, ids) => ({ items: new Map(ids.map(id => [id, snapshot])), pause: new ProviderError('Linear rate limit reached', 900_000, true) }));
  await h.harness.behavior.callRpc('subscribe', { threadId: 't1', platform: 'linear', ids: ['ENG-1', 'ENG-2'] });
  await h.harness.behavior.callRpc('subscribe', { threadId: 't2', platform: 'linear', ids: ['ENG-2'] });
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(5));
  expect(fetchBatch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetchBatch).mock.calls[0][1]).toEqual(['ENG-1', 'ENG-2']);
  const baseline: any = await h.harness.behavior.callRpc('list', { threadId: 't1' });
  expect(baseline.subscriptions.map((s: any) => s.snapshot?.state)).toEqual(['open', 'open']);
  // Next sweep: the provider is paused, so no fetch happens and rows carry the pause message.
  db(h).prepare('UPDATE subscriptions SET due=0').run();
  const service = h.harness.behavior.runService('watch'); await new Promise(r => setTimeout(r, 30)); service.controller.abort(); await service.done;
  expect(fetchBatch).toHaveBeenCalledTimes(1);
  const pausedRows: any = await h.harness.behavior.callRpc('list', { threadId: 't1' });
  expect(pausedRows.subscriptions[0].error).toContain('rate limit');
  expect(pausedRows.subscriptions[0].snapshot.state).toBe('open');
});
it('coalesces changes to several items into one message per thread', async () => {
  const h = host(); resolveAll(snapshot);
  await h.harness.behavior.callRpc('subscribe', { ...input, ids: ['o/r#1', 'o/r#2'] });
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(3));
  vi.mocked(fetchBatch).mockImplementation(async (_p, ids) => ({ items: new Map(ids.map(id => [id, { ...snapshot, state: id === 'o/r#1' ? 'merged' : 'closed' }])) })); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
  expect(sentText(h)).toBe('[Subscription update]\n- [o/r#1](https://github.com/o/r/pull/1): open → merged.\n- [o/r#2](https://github.com/o/r/pull/1): open → closed.');
});
it('rewrites the message waiting for a busy thread instead of queueing another, then starts fresh once it is read', async () => {
  const h = host(); resolveAll(snapshot);
  const queued = makeQueueEntry({ id: 'q1', threadId: 't1', updatedAt: 100 });
  h.harness.sdk.stub('threads.send', async () => ({ delivery: 'queued', ok: true, queuedMessage: queued } as never));
  h.harness.sdk.stub('threads.queuedMessages.update', async () => ({ ...queued, updatedAt: 200 } as never));
  await h.harness.behavior.callRpc('subscribe', input);
  await cycle(h, () => expect(h.harness.realtimeSignals.length).toBe(2));
  resolveAll({ ...snapshot, fields: { checks: 'pending', commit: 'abc' } }); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1));
  expect(sentText(h)).toContain('commit: none → abc');
  // Second change while still queued: the same row is rewritten with the full diff since the baseline.
  resolveAll({ ...snapshot, state: 'merged', fields: { checks: 'success', commit: 'abc' } }); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.queuedMessages.update')).toHaveLength(1));
  const update = h.harness.inspection.sdk.callsTo('threads.queuedMessages.update')[0][0] as any;
  expect(update).toMatchObject({ threadId: 't1', queuedMessageId: 'q1', expectedUpdatedAt: 100 });
  expect(update.input[0].text).toBe('[Subscription update] [o/r#1](https://github.com/o/r/pull/1): open → merged; checks: pending → success; commit: none → abc.');
  expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(1);
  // The agent reads it; the next change is a new message that only covers what happened since.
  await h.harness.behavior.emitThreadEvent('message.dispatched', { entry: queued });
  resolveAll({ ...snapshot, state: 'closed', fields: { checks: 'success', commit: 'abc' } }); await due(h);
  await cycle(h, () => expect(h.harness.inspection.sdk.callsTo('threads.send')).toHaveLength(2));
  expect(sentText(h, 1)).toBe('[Subscription update] [o/r#1](https://github.com/o/r/pull/1): merged → closed.');
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
