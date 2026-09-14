import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { compose, describe, snapshotSchema, subscriptionSchema, type Snapshot } from './model';
import { fetchBatch, githubRepositoryFromRemote, isBareNumber, platformSchema, provider, providers, providerSettings, ProviderError, type ProviderConfig } from './providers';

const scope = z.object({ threadId: z.string().min(1).max(200) });
const mutation = scope.extend({ platform: platformSchema, ids: z.array(z.string().min(1).max(1000)).min(1).max(50) });
export const rpcContract = defineRpcContract({
  list: { input: scope, output: z.object({ subscriptions: z.array(subscriptionSchema), intervalSeconds: z.number() }) },
  subscribe: { input: mutation, output: z.object({ ids: z.array(z.string()) }) },
  unsubscribe: { input: mutation, output: z.object({ ids: z.array(z.string()) }) },
});
type Pending = { thread: string; baselines: string; flush_at: number; dirty: number; queued_id: string | null; queued_updated: number | null };
type Row = { thread: string; platform: string; id: string; snapshot: string | null; error: string | null; checked: number | null; due: number; failures: number; generation: string };
const MAX_PER_THREAD = 100;
const platforms = providers.map(p => p.id).join('|');
const backoff = (failures: number) => Math.min(3600_000, 30_000 * 2 ** Math.min(failures, 7));

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    intervalSeconds: { type: 'number', label: 'Check interval in seconds', default: 60, experimental_schema: z.number().int().min(30).max(3600) },
    debounceSeconds: { type: 'number', label: 'Debounce notifications within (seconds)', description: 'Changes seen within this window go out as one message. While a thread is busy, later changes rewrite the message already waiting for it.', default: 10, experimental_schema: z.number().int().min(0).max(600) },
    ...providerSettings,
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [`CREATE TABLE subscriptions (thread TEXT NOT NULL, platform TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT, error TEXT, checked INTEGER, due INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, generation TEXT NOT NULL, PRIMARY KEY(thread, platform, id))`,
    `CREATE TABLE pending (thread TEXT PRIMARY KEY, baselines TEXT NOT NULL, flush_at INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, queued_id TEXT, queued_updated INTEGER)`]);
  const changed = (threadId: string) => bb.realtime.publish('subscriptions-changed', { threadId });
  const rows = (threadId: string) => db.prepare('SELECT * FROM subscriptions WHERE thread = ? ORDER BY platform, id').all(threadId) as Row[];
  const list = async ({ threadId }: z.infer<typeof scope>) => ({
    subscriptions: rows(threadId).map(row => ({ platform: row.platform, id: row.id, snapshot: row.snapshot ? snapshotSchema.parse(JSON.parse(row.snapshot)) : null, error: row.error, checkedAt: row.checked })),
    intervalSeconds: (await settings.get()).intervalSeconds,
  });

  // Serializes delivery against unsubscribe: once removal returns, no new send can start.
  let lock: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = lock.then(fn); lock = next.catch(() => {}); return next;
  }

  async function mutate(input: z.infer<typeof mutation>, add: boolean) {
    const config = await settings.get() as ProviderConfig;
    // Bare PR numbers resolve against the thread's project remote unless a default repository is configured.
    const needsRemote = input.platform === 'github' && !config.githubRepository && input.ids.some(isBareNumber);
    const thread = add || needsRemote ? await bb.sdk.threads.get({ threadId: input.threadId }) : null;
    const repository = (config.githubRepository as string) || (needsRemote && thread?.projectId
      ? githubRepositoryFromRemote((await bb.sdk.projects.get({ projectId: thread.projectId })).gitRemoteUrl) : '');
    const ids = [...new Set(input.ids.map(id => provider(input.platform).canonical(id, { config, repository })))];
    return serial(async () => {
      db.transaction(() => {
        if (add) {
          const fresh = ids.filter(id => !db.prepare('SELECT 1 FROM subscriptions WHERE thread=? AND platform=? AND id=?').get(input.threadId, input.platform, id)).length;
          if (rows(input.threadId).length + fresh > MAX_PER_THREAD) throw new Error(`Maximum ${MAX_PER_THREAD} subscriptions per thread.`);
        }
        for (const id of ids) {
          if (add) db.prepare('INSERT OR IGNORE INTO subscriptions (thread,platform,id,generation) VALUES (?,?,?,?)').run(input.threadId, input.platform, id, randomUUID());
          else db.prepare('DELETE FROM subscriptions WHERE thread=? AND platform=? AND id=?').run(input.threadId, input.platform, id);
        }
      })();
      changed(input.threadId); return { ids };
    });
  }
  bb.rpc.register(rpcContract, { list, subscribe: input => mutate(input, true), unsubscribe: input => mutate(input, false) });

  const usage = [
    `bb subscriptions (subscribe|unsubscribe) (${platforms}) <id> [id…] [--thread <id>] [--json]`,
    'bb subscriptions list [--thread <id>] [--json]',
    ...providers.map(p => `  ${p.id}: ${p.label}, e.g. ${p.example}`),
  ].join('\n');
  bb.cli.register({ name: 'subscriptions', summary: `Subscribe this thread to ${providers.map(p => p.label).join(' and ')} updates`, commands: [
    { name: 'subscribe', summary: 'Subscribe one or more IDs (alias: sub)', usage: `bb subscriptions subscribe <${platforms}> <id> [id…] [--thread <id>] [--json]` },
    { name: 'unsubscribe', summary: 'Unsubscribe one or more IDs (alias: unsub)', usage: `bb subscriptions unsubscribe <${platforms}> <id> [id…] [--thread <id>] [--json]` },
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

  bb.agents.registerTool({
    name: 'thread_subscriptions',
    description: `Subscribe/unsubscribe this thread to updates for ${providers.map(p => `${p.label}s (${p.id}, e.g. ${p.example})`).join(' or ')}, or list subscriptions. Accepts multiple IDs per platform.`,
    parameters: z.object({ action: z.enum(['subscribe', 'unsubscribe', 'list']), platform: platformSchema.optional(), ids: z.array(z.string()).max(50).optional() }),
    async execute(input, ctx) {
      if (input.action === 'list') return JSON.stringify(await list({ threadId: ctx.threadId }));
      return JSON.stringify(await mutate(mutation.parse({ threadId: ctx.threadId, platform: input.platform, ids: input.ids }), input.action === 'subscribe'));
    },
  });

  bb.events.on('thread.deleted', ({ thread }) => serial(async () => { db.prepare('DELETE FROM subscriptions WHERE thread=?').run(thread.id); db.prepare('DELETE FROM pending WHERE thread=?').run(thread.id); changed(thread.id); }));
  // Once the agent has read (or the user removed) our queued message, later changes start from a fresh baseline.
  const consumed = ({ entry }: { entry: { id: string; threadId: string } }) => serial(async () => { db.prepare('DELETE FROM pending WHERE thread=? AND queued_id=?').run(entry.threadId, entry.id); });
  bb.events.on('message.dispatched', consumed);
  bb.events.on('message.cancelled', consumed);
  // A settings change (new key, new interval) re-checks everything and lifts any provider pause.
  const paused = new Map<string, { until: number; message: string }>();
  settings.onChange(() => { paused.clear(); db.prepare('UPDATE subscriptions SET due=0, failures=0').run(); });
  const lifecycle = new AbortController();
  bb.onDispose(async () => { lifecycle.abort(); await lock; });

  async function poll(signal: AbortSignal) {
    const config = await settings.get() as ProviderConfig;
    const interval = (config.intervalSeconds as number) * 1000;
    const debounce = (config.debounceSeconds as number) * 1000;
    const now = Date.now();
    const due = db.prepare('SELECT * FROM subscriptions WHERE due <= ? ORDER BY due LIMIT 100').all(now) as Row[];
    if (!due.length) return;
    // Look each thread up once per sweep; archived threads are skipped until the next interval.
    const threads = new Map<string, Promise<{ archived: boolean }>>();
    const threadState = (threadId: string) => {
      if (!threads.has(threadId)) threads.set(threadId, bb.sdk.threads.get({ threadId }).then(t => ({ archived: t.archivedAt !== null }), () => ({ archived: false })));
      return threads.get(threadId)!;
    };
    const active: Row[] = [];
    for (const row of due) {
      if (signal.aborted) return;
      if ((await threadState(row.thread)).archived) db.prepare('UPDATE subscriptions SET due=? WHERE thread=? AND platform=? AND id=?').run(now + interval, row.thread, row.platform, row.id);
      else active.push(row);
    }
    // One batch per platform per sweep, however many threads follow the same item.
    const byPlatform = new Map<string, Row[]>();
    for (const row of active) byPlatform.set(row.platform, [...byPlatform.get(row.platform) ?? [], row]);
    for (const [platform, group] of byPlatform) {
      if (signal.aborted) return;
      const pause = paused.get(platform);
      let items: Map<string, Snapshot | ProviderError>;
      if (pause && pause.until > now) {
        items = new Map(group.map(row => [row.id, new ProviderError(pause.message, pause.until - now)]));
      } else {
        const ids = [...new Set(group.map(row => row.id))];
        const result = await fetchBatch(platform, ids, { config, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000 * Math.ceil(ids.length / 4))]) });
        items = result.items;
        if (result.pause) paused.set(platform, { until: Date.now() + result.pause.retryMs, message: result.pause.message });
        else paused.delete(platform);
      }
      if (signal.aborted) return;
      for (const row of group) await deliver(row, items.get(row.id) ?? new ProviderError('No result returned for this item; will retry.'), interval, debounce, signal);
    }
  }

  /** Note a change for the thread's next message, keeping the oldest unseen baseline per item. */
  function record(thread: string, key: string, before: Snapshot, debounce: number) {
    const pending = db.prepare('SELECT * FROM pending WHERE thread=?').get(thread) as Pending | undefined;
    const baselines: Record<string, Snapshot> = pending ? JSON.parse(pending.baselines) : {};
    baselines[key] ??= before;
    if (!pending) db.prepare('INSERT INTO pending (thread,baselines,flush_at,dirty) VALUES (?,?,?,1)').run(thread, JSON.stringify(baselines), Date.now() + debounce);
    else db.prepare('UPDATE pending SET baselines=?, dirty=1, flush_at=CASE WHEN dirty=1 THEN flush_at ELSE ? END WHERE thread=?').run(JSON.stringify(baselines), Date.now() + debounce, thread);
  }
  /** Send or rewrite one message per thread whose debounce window has passed. */
  async function flush(signal: AbortSignal) {
    const ready = db.prepare('SELECT * FROM pending WHERE dirty=1 AND flush_at <= ?').all(Date.now()) as Pending[];
    for (const pending of ready) {
      if (signal.aborted) return;
      await serial(async () => {
        const current = db.prepare('SELECT * FROM pending WHERE thread=?').get(pending.thread) as Pending | undefined;
        if (!current || !current.dirty || signal.aborted) return;
        const baselines: Record<string, Snapshot> = JSON.parse(current.baselines);
        const lines: string[] = [];
        for (const [key, before] of Object.entries(baselines)) {
          const [platform, id] = key.split(/:(.*)/s);
          const row = db.prepare('SELECT snapshot FROM subscriptions WHERE thread=? AND platform=? AND id=?').get(current.thread, platform, id) as Pick<Row, 'snapshot'> | undefined;
          const line = row?.snapshot ? describe(id, before, snapshotSchema.parse(JSON.parse(row.snapshot))) : null;
          if (line) lines.push(line);
        }
        const text = compose(lines);
        if (!text) { db.prepare('DELETE FROM pending WHERE thread=?').run(current.thread); return; }
        const input = [{ type: 'text' as const, text, mentions: [] }];
        try {
          if (current.queued_id !== null && current.queued_updated !== null) {
            try {
              const updated = await bb.sdk.threads.queuedMessages.update({ threadId: current.thread, queuedMessageId: current.queued_id, expectedUpdatedAt: current.queued_updated, input });
              db.prepare('UPDATE pending SET dirty=0, queued_updated=? WHERE thread=?').run(updated.updatedAt, current.thread);
              return;
            } catch { /* Row consumed, edited or removed since: fall through to a fresh send. */ }
          }
          const sent = await bb.sdk.threads.send({ threadId: current.thread, mode: 'queue-if-active', input });
          if (sent.delivery === 'queued') db.prepare('UPDATE pending SET dirty=0, queued_id=?, queued_updated=? WHERE thread=?').run(sent.queuedMessage.id, sent.queuedMessage.updatedAt, current.thread);
          else db.prepare('DELETE FROM pending WHERE thread=?').run(current.thread);
        } catch {
          // Delivery failed (bb offline, thread gone): keep the baselines and retry on a later sweep.
          db.prepare('UPDATE pending SET flush_at=? WHERE thread=?').run(Date.now() + 5_000, current.thread);
        }
      });
    }
  }

  function deliver(row: Row, outcome: Snapshot | ProviderError, interval: number, debounce: number, signal: AbortSignal) {
    return serial(async () => {
      const current = db.prepare('SELECT * FROM subscriptions WHERE thread=? AND platform=? AND id=?').get(row.thread, row.platform, row.id) as Row | undefined;
      if (!current || current.generation !== row.generation || signal.aborted) return;
      try {
        if (outcome instanceof ProviderError) throw outcome;
        const snapshot = snapshotSchema.parse(outcome);
        const before = current.snapshot ? snapshotSchema.parse(JSON.parse(current.snapshot)) : null;
        if (before && describe(row.id, before, snapshot)) record(row.thread, `${row.platform}:${row.id}`, before, debounce);
        db.prepare('UPDATE subscriptions SET snapshot=?,error=NULL,checked=?,due=?,failures=0 WHERE thread=? AND platform=? AND id=?').run(JSON.stringify(snapshot), Date.now(), Date.now() + interval, row.thread, row.platform, row.id);
      } catch (cause) {
        const delay = cause instanceof ProviderError ? cause.retryMs : 60_000;
        const message = cause instanceof ProviderError ? cause.message : 'Check or message delivery failed; will retry.';
        db.prepare('UPDATE subscriptions SET error=?,checked=?,due=?,failures=failures+1 WHERE thread=? AND platform=? AND id=?').run(message, Date.now(), Date.now() + Math.max(delay, backoff(current.failures)), row.thread, row.platform, row.id);
      }
      changed(row.thread);
    });
  }

  bb.background.service('watch', { async start(serviceSignal) {
    const signal = AbortSignal.any([serviceSignal, lifecycle.signal]);
    while (!signal.aborted) {
      await poll(signal);
      if (!signal.aborted) await flush(signal);
      try { await sleep(5000, undefined, { signal }); } catch { if (!signal.aborted) throw new Error('Watcher sleep failed'); }
    }
  } });
}
