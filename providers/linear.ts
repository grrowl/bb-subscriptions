import { z } from 'zod';
import type { Snapshot } from '../model';
import { ProviderError, type BatchResult, type FetchResult, type Provider, type ProviderContext } from './types';

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
/** Stop issuing requests when fewer than this many remain in the hourly window. */
const REMAINING_FLOOR = 100;
/** Issues per request; keeps complexity well under Linear's 10 000-point per-query cap. */
const CHUNK = 50;
export const issueFields = `fragment IssueFields on Issue {
  title url updatedAt state { name } assignee { name } priority
  labels(first: 100) { nodes { name } }
  comments(first: 1, orderBy: updatedAt) { nodes { id updatedAt user { name } } }
}`;
const issueSchema = z.object({
  title: z.string(), url: z.string().url().refine(v => new URL(v).hostname === 'linear.app'), updatedAt: z.string(),
  state: z.object({ name: z.string() }), assignee: z.object({ name: z.string() }).nullable(), priority: z.number(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  comments: z.object({ nodes: z.array(z.object({ id: z.string(), updatedAt: z.string(), user: z.object({ name: z.string() }).nullable() })) }),
});
const envelope = z.object({
  errors: z.array(z.object({ message: z.string().optional(), path: z.array(z.union([z.string(), z.number()])).optional(), extensions: z.object({ code: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
  data: z.record(z.string(), issueSchema.nullable()).nullable().optional(),
});

/** Build one query that fetches every ID under an alias (`i0`, `i1`, …). */
export function batchQuery(ids: string[]): { query: string; variables: Record<string, string>; aliases: string[] } {
  const aliases = ids.map((_, i) => `i${i}`);
  const params = aliases.map(a => `$${a}: String!`).join(', ');
  const body = aliases.map(a => `${a}: issue(id: $${a}) { ...IssueFields }`).join('\n  ');
  return { query: `${issueFields}\nquery SubscriptionIssues(${params}) {\n  ${body}\n}`, variables: Object.fromEntries(aliases.map((a, i) => [a, ids[i]])), aliases };
}

export function toSnapshot(issue: z.infer<typeof issueSchema>): Snapshot {
  const comment = issue.comments.nodes[0];
  return {
    title: issue.title, url: issue.url, state: issue.state.name, updatedAt: issue.updatedAt,
    fields: {
      assignee: issue.assignee?.name ?? '',
      priority: ['none', 'urgent', 'high', 'medium', 'low'][issue.priority] ?? String(issue.priority),
      labels: issue.labels.nodes.map(x => x.name).sort().join(', '),
      'latest comment': comment ? `${comment.updatedAt}${comment.user ? ` by ${comment.user.name}` : ''}` : '',
    },
  };
}

/** Milliseconds until the hourly window resets, from Linear's rate-limit headers; null when absent. */
export function resetDelay(headers: Headers, now = Date.now()): number | null {
  const reset = Number(headers.get('x-ratelimit-requests-reset'));
  return Number.isFinite(reset) && reset > 0 ? Math.max(60_000, reset - now) : null;
}

async function fetchChunk(ids: string[], key: string, signal: AbortSignal): Promise<FetchResult> {
  const { query, variables, aliases } = batchQuery(ids);
  let response: Response;
  try {
    response = await fetch(LINEAR_ENDPOINT, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: key }, body: JSON.stringify({ query, variables }) });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ProviderError('Linear API unreachable from the bb server; will retry.');
  }
  if (response.status === 401 || response.status === 403) throw new ProviderError('Linear rejected the API key. Generate a new read-only personal key and set linearApiKey.', 3600_000, true);
  const raw: unknown = await response.json().catch(() => null);
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) {
    if (response.status >= 500) throw new ProviderError(`Linear API error ${response.status}; will retry.`);
    throw new ProviderError('Linear returned an unexpected response; will retry.');
  }
  const rateLimited = parsed.data.errors?.some(e => e.extensions?.code === 'RATELIMITED');
  if (rateLimited) throw new ProviderError('Linear rate limit reached; pausing Linear checks until the window resets.', resetDelay(response.headers) ?? 15 * 60_000, true);
  const remaining = Number(response.headers.get('x-ratelimit-requests-remaining'));
  const pause = Number.isFinite(remaining) && remaining < REMAINING_FLOOR ? new ProviderError('Linear request budget nearly exhausted; pausing until the window resets.', resetDelay(response.headers) ?? 15 * 60_000, true) : null;
  const results: BatchResult = new Map();
  aliases.forEach((alias, i) => {
    const issue = parsed.data.data?.[alias];
    const error = parsed.data.errors?.find(e => e.path?.[0] === alias);
    if (issue) results.set(ids[i], toSnapshot(issue));
    else if (error?.extensions?.code === 'AUTHENTICATION_ERROR') results.set(ids[i], new ProviderError('Linear rejected the API key. Generate a new read-only personal key and set linearApiKey.', 3600_000, true));
    else results.set(ids[i], new ProviderError('Linear issue not found or not visible to this key (check the key\'s team scope).'));
  });
  return pause ? { items: results, pause } : { items: results };
}

export const linear: Provider = {
  id: 'linear', label: 'Linear issue', example: 'ENG-123',
  settings: {
    linearApiKey: { type: 'string', label: 'Linear personal API key', description: 'Settings → Account → Security & access. Only the Read permission is needed; team-scoped keys work.', secret: true },
  },
  canonical(raw) {
    let id = raw.trim();
    const url = /^https:\/\/linear\.app\/[^/]+\/issue\/([a-z0-9]+-[1-9]\d*)(?:[/?#].*)?$/i.exec(id);
    if (url) id = url[1];
    if (!/^[a-z][a-z0-9]*-[1-9]\d*$/i.test(id)) throw new Error('Use a Linear issue ID such as ENG-123 or its URL.');
    return id.toUpperCase();
  },
  async fetch(ids, { config, signal }: ProviderContext) {
    const key = typeof config.linearApiKey === 'string' ? config.linearApiKey.trim() : '';
    if (!key) throw new ProviderError('Linear API key not set. Run: bb plugin config subscriptions set linearApiKey <read-only key>', 3600_000, true);
    const items: BatchResult = new Map(); let pause: ProviderError | undefined;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = await fetchChunk(ids.slice(i, i + CHUNK), key, signal);
      for (const [id, value] of chunk.items) items.set(id, value);
      pause ??= chunk.pause;
      if (pause) break;
    }
    return { items, pause };
  },
};
