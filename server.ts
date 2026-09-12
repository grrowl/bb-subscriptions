import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { canonical, describe, platformSchema, snapshotSchema, subscriptionSchema, type Platform, type Snapshot } from './model';
import { fetchSnapshot, ProviderError } from './providers';
const scope = z.object({ threadId: z.string().min(1).max(200) });
const mutation = scope.extend({ platform: platformSchema, ids: z.array(z.string().min(1).max(1000)).min(1).max(50) });
export const rpcContract = defineRpcContract({
  list: { input: scope, output: z.object({ subscriptions: z.array(subscriptionSchema), intervalSeconds: z.number() }) },
  subscribe: { input: mutation, output: z.object({ ids: z.array(z.string()) }) },
  unsubscribe: { input: mutation, output: z.object({ ids: z.array(z.string()) }) },
});
type Row = { thread: string; platform: Platform; id: string; snapshot: string | null; error: string | null; checked: number | null; due: number; failures: number; generation: string };
export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    linearWorkspace: { type: 'string', label: 'Linear workspace (optional; uses CLI default)', default: '' },
    githubRepository: { type: 'string', label: 'Default GitHub repository (owner/repo)', default: '' },
    intervalSeconds: { type: 'number', label: 'Check interval in seconds', default: 60, experimental_schema: z.number().int().min(30).max(3600) },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [`CREATE TABLE subscriptions (thread TEXT NOT NULL, platform TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT, error TEXT, checked INTEGER, due INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, generation TEXT NOT NULL, PRIMARY KEY(thread, platform, id))`]);
  const changed = (threadId: string) => bb.realtime.publish('subscriptions-changed', { threadId });
  const rows = (threadId: string) => db.prepare('SELECT * FROM subscriptions WHERE thread = ? ORDER BY platform, id').all(threadId) as Row[];
  const list = async ({ threadId }: z.infer<typeof scope>) => ({ subscriptions: rows(threadId).map(row => ({ platform: row.platform, id: row.id, snapshot: row.snapshot ? snapshotSchema.parse(JSON.parse(row.snapshot)) : null, error: row.error, checkedAt: row.checked })), intervalSeconds: (await settings.get()).intervalSeconds });
  // Serializes delivery against unsubscribe: once removal returns, no new send can start.
  let lock: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = lock.then(fn); lock = next.catch(() => {}); return next;
  }
  async function mutate(input: z.infer<typeof mutation>, add: boolean) {
    const config = await settings.get();
    const ids = [...new Set(input.ids.map(id => canonical(input.platform, id, config.githubRepository)))];
    if (add) await bb.sdk.threads.get({ threadId: input.threadId });
    return serial(async () => {
      db.transaction(() => {
        if (add && rows(input.threadId).length + ids.filter(id => !db.prepare('SELECT 1 FROM subscriptions WHERE thread=? AND platform=? AND id=?').get(input.threadId, input.platform, id)).length > 100) throw new Error('Maximum 100 subscriptions per thread.');
        for (const id of ids) {
          if (add) db.prepare('INSERT OR IGNORE INTO subscriptions (thread,platform,id,generation) VALUES (?,?,?,?)').run(input.threadId, input.platform, id, randomUUID());
          else db.prepare('DELETE FROM subscriptions WHERE thread=? AND platform=? AND id=?').run(input.threadId, input.platform, id);
        }
      })();
      changed(input.threadId); return { ids };
    });
  }
  bb.rpc.register(rpcContract, { list, subscribe: input => mutate(input, true), unsubscribe: input => mutate(input, false) });
  const usage = 'bb subscriptions (subscribe|unsubscribe) (github|linear) <id> [id…] [--thread <id>] [--json]\nbb subscriptions list [--thread <id>] [--json]';
  bb.cli.register({ name: 'subscriptions', summary: 'Subscribe this thread to GitHub PR and Linear issue updates', commands: [
    { name: 'subscribe', summary: 'Subscribe one or more IDs (alias: sub)', usage: 'bb subscriptions subscribe <github|linear> <id> [id…] [--thread <id>]' },
    { name: 'unsubscribe', summary: 'Unsubscribe one or more IDs (alias: unsub)', usage: 'bb subscriptions unsubscribe <github|linear> <id> [id…] [--thread <id>]' },
    { name: 'list', summary: 'List subscriptions for this thread', usage: 'bb subscriptions list [--thread <id>] [--json]' },
  ], async run(argv, ctx) {
    try {
      if (!argv.length || argv.includes('--help') || argv[0] === 'help') return { exitCode: 0, stdout: usage };
      const args: string[] = []; let threadId = ctx.threadId; let json = false;
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--json') json = true;
        else if (argv[i] === '--thread') { threadId = argv[++i]; if (!threadId || threadId.startsWith('--')) throw new Error('--thread requires a thread ID.'); }
        else if (argv[i].startsWith('--')) throw new Error(`Unknown option ${argv[i]}`);
        else args.push(argv[i]);
      }
      if (!threadId) throw new Error('Run from a bb thread or supply --thread <id>.');
      const [action, platform, ...ids] = args;
      if (action === 'list' && args.length === 1) {
        const result = await list(scope.parse({ threadId }));
        return { exitCode: 0, stdout: json ? JSON.stringify(result) : result.subscriptions.map(s => `${s.platform} ${s.id} — ${s.error ?? s.snapshot?.state ?? 'waiting for first check'}`).join('\n') || 'No subscriptions in this thread.' };
      }
      if (!['subscribe', 'sub', 'unsubscribe', 'unsub'].includes(action)) throw new Error(usage);
      const add = action === 'subscribe' || action === 'sub';
      const result = await mutate(mutation.parse({ threadId, platform, ids: ids.flatMap(id => id.split(',')).filter(Boolean) }), add);
      return { exitCode: 0, stdout: json ? JSON.stringify(result) : `${add ? 'Subscribed' : 'Unsubscribed'}: ${result.ids.join(', ')}${add ? '. First successful check establishes the baseline.' : '.'}` };
    } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : 'Subscription command failed.' }; }
  } });
  bb.agents.registerTool({ name: 'thread_subscriptions', description: 'Subscribe/unsubscribe this thread to updates for GitHub PRs or Linear issues, or list subscriptions. Accepts multiple IDs per platform.', parameters: z.object({ action: z.enum(['subscribe', 'unsubscribe', 'list']), platform: platformSchema.optional(), ids: z.array(z.string()).max(50).optional() }), async execute(input, ctx) {
    if (input.action === 'list') return JSON.stringify(await list({ threadId: ctx.threadId }));
    return JSON.stringify(await mutate(mutation.parse({ threadId: ctx.threadId, platform: input.platform, ids: input.ids }), input.action === 'subscribe'));
  } });
  bb.events.on('thread.deleted', ({ thread }) => serial(async () => { db.prepare('DELETE FROM subscriptions WHERE thread=?').run(thread.id); changed(thread.id); }));
  settings.onChange(() => { db.prepare('UPDATE subscriptions SET due=0, failures=0').run(); });
  const lifecycle = new AbortController();
  bb.onDispose(async () => { lifecycle.abort(); await lock; });
  async function poll(signal: AbortSignal) {
    const config = await settings.get();
    const due = db.prepare('SELECT * FROM subscriptions WHERE due <= ? ORDER BY due LIMIT 100').all(Date.now()) as Row[];
    // Fetch once per item per sweep, even when several threads follow it.
    const cache = new Map<string, Promise<Snapshot>>();
    for (const row of due) {
      if (signal.aborted) return;
      let snapshot: Snapshot | undefined; let error: unknown;
      try {
        const thread = await bb.sdk.threads.get({ threadId: row.thread });
        if (thread.archivedAt !== null) { db.prepare('UPDATE subscriptions SET due=? WHERE thread=? AND platform=? AND id=?').run(Date.now() + config.intervalSeconds * 1000, row.thread, row.platform, row.id); continue; }
        const key = `${row.platform}:${row.id}`;
        if (!cache.has(key)) cache.set(key, fetchSnapshot(row.platform, row.id, config, AbortSignal.any([signal, AbortSignal.timeout(20_000)])));
        snapshot = snapshotSchema.parse(await cache.get(key));
      } catch (cause) { error = cause; }
      if (signal.aborted) return;
      await serial(async () => {
        const current = db.prepare('SELECT * FROM subscriptions WHERE thread=? AND platform=? AND id=?').get(row.thread, row.platform, row.id) as Row | undefined;
        if (!current || current.generation !== row.generation || signal.aborted) return;
        try {
          if (error) throw error;
          if (!snapshot) throw new Error('No snapshot');
          const before = current.snapshot ? snapshotSchema.parse(JSON.parse(current.snapshot)) : null;
          const message = before ? describe(row.id, before, snapshot) : null;
          if (message) await bb.sdk.threads.send({ threadId: row.thread, mode: 'queue-if-active', input: [{ type: 'text', text: message, mentions: [] }] });
          db.prepare('UPDATE subscriptions SET snapshot=?,error=NULL,checked=?,due=?,failures=0 WHERE thread=? AND platform=? AND id=?').run(JSON.stringify(snapshot), Date.now(), Date.now() + config.intervalSeconds * 1000, row.thread, row.platform, row.id);
        } catch (cause) {
          const delay = cause instanceof ProviderError ? cause.retryMs : 60_000;
          const message = cause instanceof ProviderError ? cause.message : 'Check or message delivery failed; will retry.';
          db.prepare('UPDATE subscriptions SET error=?,checked=?,due=?,failures=failures+1 WHERE thread=? AND platform=? AND id=?').run(message, Date.now(), Date.now() + Math.max(delay, Math.min(3600_000, 30_000 * 2 ** Math.min(current.failures, 7))), row.thread, row.platform, row.id);
        }
        changed(row.thread);
      });
    }
  }
  bb.background.service('watch', { async start(serviceSignal) {
    const signal = AbortSignal.any([serviceSignal, lifecycle.signal]);
    while (!signal.aborted) {
      await poll(signal);
      try { await sleep(5000, undefined, { signal }); } catch { if (!signal.aborted) throw new Error('Watcher sleep failed'); }
    }
  } });
}
