import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Snapshot } from '../model';
import { mapLimit, ProviderError, type Provider, type ProviderContext } from './types';
const exec = promisify(execFile);

export const githubQuery = `query SubscriptionGitHub($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { issueOrPullRequest(number: $number) {
    __typename
    ... on Issue {
      title url state stateReason updatedAt
      assignees(first: 50) { nodes { login } }
      labels(first: 100) { nodes { name } }
      comments(last: 1) { totalCount nodes { updatedAt author { login } } }
    }
    ... on PullRequest {
      title url state isDraft updatedAt headRefOid reviewDecision
      assignees(first: 50) { nodes { login } }
      labels(first: 100) { nodes { name } }
      comments(last: 1) { totalCount nodes { updatedAt author { login } } }
      reviews(last: 1) { totalCount nodes { state submittedAt author { login } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  } }
}`;
const commonSchema = z.object({
  title: z.string(), url: z.string().url(), state: z.string(), updatedAt: z.string(),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  comments: z.object({ totalCount: z.number(), nodes: z.array(z.object({ updatedAt: z.string(), author: z.object({ login: z.string() }).nullable() })) }),
});
const issueSchema = commonSchema.extend({ __typename: z.literal('Issue'), stateReason: z.string().nullable() });
const prSchema = commonSchema.extend({
  __typename: z.literal('PullRequest'), isDraft: z.boolean(), headRefOid: z.string(), reviewDecision: z.string().nullable(),
  reviews: z.object({ totalCount: z.number(), nodes: z.array(z.object({ state: z.string(), submittedAt: z.string().nullable(), author: z.object({ login: z.string() }).nullable() })) }),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) }),
});
const itemSchema = z.discriminatedUnion('__typename', [issueSchema, prSchema]);
const envelope = z.object({ errors: z.array(z.unknown()).optional(), data: z.object({ repository: z.object({ issueOrPullRequest: itemSchema.nullable() }).nullable() }).optional() });

/** Return the GitHub owner/repository part of a standard Git remote URL. */
export function githubRepositoryFromRemote(remote: string | null): string {
  if (remote === null) return '';
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match?.[1]?.toLowerCase() ?? '';
}
/** True when the input needs a default repository to resolve (bare `123` or `#123`). */
export const isBareNumber = (raw: string) => /^#?[1-9]\d*$/.test(raw.trim());

export function toSnapshot(item: z.infer<typeof itemSchema>): Snapshot {
  const comment = item.comments.nodes[0];
  const fields = {
    comments: `${item.comments.totalCount}${comment ? ` (latest by ${comment.author?.login ?? 'unknown'} at ${comment.updatedAt})` : ''}`,
    assignees: item.assignees.nodes.map(x => x.login).sort().join(', '),
    labels: item.labels.nodes.map(x => x.name).sort().join(', '),
  };
  if (item.__typename === 'Issue') return {
    title: item.title, url: item.url, updatedAt: item.updatedAt, state: item.state.toLowerCase(),
    fields: { 'state reason': item.stateReason?.toLowerCase().replaceAll('_', ' ') ?? '', ...fields },
  };
  const review = item.reviews.nodes[0];
  return {
    title: item.title, url: item.url, updatedAt: item.updatedAt,
    state: item.state === 'OPEN' && item.isDraft ? 'draft' : item.state.toLowerCase(),
    fields: {
      commit: item.headRefOid.slice(0, 12),
      comments: fields.comments,
      reviews: `${item.reviews.totalCount}${review ? ` (${review.author?.login ?? 'unknown'}: ${review.state.toLowerCase()} at ${review.submittedAt ?? 'pending'})` : ''}`,
      'review decision': item.reviewDecision?.toLowerCase() ?? '',
      checks: item.commits.nodes[0]?.commit.statusCheckRollup?.state.toLowerCase() ?? '',
      assignees: fields.assignees,
      labels: fields.labels,
    },
  };
}

async function fetchOne(id: string, { signal }: ProviderContext): Promise<Snapshot> {
  const [repo, number] = id.split('#'); const [owner, name] = repo.split('/');
  const args = ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${githubQuery}`, '-f', `owner=${owner}`, '-f', `repo=${name}`, '-F', `number=${number}`];
  let raw: unknown;
  try {
    const { stdout } = await exec('gh', args, { signal, timeout: 20_000, maxBuffer: 2_000_000 });
    raw = JSON.parse(stdout);
  } catch (cause) {
    if (signal.aborted) throw cause;
    const diagnostic = cause && typeof cause === 'object' && 'stderr' in cause ? String(cause.stderr) : '';
    if (/rate.?limit|too many requests/i.test(diagnostic)) throw new ProviderError('GitHub rate limit reached; pausing GitHub checks.', 15 * 60_000, true);
    throw new ProviderError('gh lookup failed. Check the PR/issue ID and gh authentication on the bb server.');
  }
  const parsed = envelope.parse(raw);
  if (parsed.errors?.length || !parsed.data?.repository?.issueOrPullRequest) throw new ProviderError('GitHub query failed; check PR/issue access and gh authentication.');
  return toSnapshot(parsed.data.repository.issueOrPullRequest);
}

export const github: Provider = {
  id: 'github', label: 'GitHub PR/issue', example: 'owner/repo#123',
  settings: {
    githubRepository: { type: 'string', label: 'Default GitHub repository (owner/repo)', description: 'Enables bare PR/issue numbers outside a project thread. Project threads infer this from their git remote.', default: '' },
  },
  canonical(raw, { repository = '' }) {
    let id = raw.trim();
    const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/([1-9]\d*)(?:[/?#].*)?$/.exec(id);
    if (url) id = `${url[1]}#${url[2]}`;
    if (isBareNumber(id)) id = `${repository}#${id.replace('#', '')}`;
    if (!/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(id)) throw new Error('Use owner/repo#123 or a GitHub PR/issue URL. Bare numbers work automatically in a project with a GitHub remote; otherwise set githubRepository.');
    return id.toLowerCase();
  },
  async fetch(ids, ctx) {
    const results = await mapLimit(ids, 4, id => fetchOne(id, ctx).catch((error: unknown) => error instanceof ProviderError ? error : Promise.reject(error)));
    return { items: new Map(ids.map((id, i) => [id, results[i]])) };
  },
};
