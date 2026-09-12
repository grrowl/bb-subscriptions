import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Platform, Snapshot } from './model';
const exec = promisify(execFile);
export class ProviderError extends Error {
  constructor(message: string, public retryMs = 60_000) { super(message); }
}
export const githubQuery = `query SubscriptionPR($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    title state isDraft updatedAt headRefOid reviewDecision
    assignees(first: 50) { nodes { login } }
    labels(first: 100) { nodes { name } }
    comments(last: 1) { totalCount nodes { updatedAt } }
    reviews(last: 1) { totalCount nodes { state submittedAt author { login } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  } }
}`;
export const linearQuery = `query SubscriptionIssue($id: String!) {
  issue(id: $id) { title url updatedAt state { name } assignee { name } priority
    labels(first: 100) { nodes { name } }
    comments(first: 1, orderBy: updatedAt) { nodes { id updatedAt } }
  }
}`;
const prSchema = z.object({ title: z.string(), state: z.string(), isDraft: z.boolean(), updatedAt: z.string(), headRefOid: z.string(), reviewDecision: z.string().nullable(),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }), labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  comments: z.object({ totalCount: z.number(), nodes: z.array(z.object({ updatedAt: z.string() })) }),
  reviews: z.object({ totalCount: z.number(), nodes: z.array(z.object({ state: z.string(), submittedAt: z.string().nullable(), author: z.object({ login: z.string() }).nullable() })) }),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) }),
});
const issueSchema = z.object({ title: z.string(), url: z.string().url().refine(v => new URL(v).hostname === 'linear.app'), updatedAt: z.string(),
  state: z.object({ name: z.string() }), assignee: z.object({ name: z.string() }).nullable(), priority: z.number(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  comments: z.object({ nodes: z.array(z.object({ id: z.string(), updatedAt: z.string() })) }),
});
export async function fetchSnapshot(platform: Platform, id: string, config: { linearWorkspace?: string }, signal: AbortSignal): Promise<Snapshot> {
  let command: string; let args: string[];
  if (platform === 'github') {
    const [repo, number] = id.split('#'); const [owner, name] = repo.split('/');
    command = 'gh'; args = ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${githubQuery}`, '-f', `owner=${owner}`, '-f', `repo=${name}`, '-F', `number=${number}`];
  } else {
    command = 'linear'; args = ['api', linearQuery, '--variables-json', JSON.stringify({ id })];
    if (config.linearWorkspace) args.push('--workspace', config.linearWorkspace);
  }
  let raw: unknown;
  try {
    const { stdout } = await exec(command, args, { signal, timeout: 20_000, maxBuffer: 2_000_000 });
    raw = JSON.parse(stdout);
  } catch (cause) {
    if (signal.aborted) throw cause;
    const diagnostic = cause && typeof cause === 'object' && 'stderr' in cause ? String(cause.stderr) : '';
    if (/rate.?limit|too many requests/i.test(diagnostic)) throw new ProviderError(`${platform} rate limit reached; retrying later.`, 15 * 60_000);
    throw new ProviderError(`${command} lookup failed. Check the item ID and ${command} authentication on the bb server${platform === 'linear' ? ' (and linearWorkspace setting)' : ''}.`);
  }
  if (platform === 'github') {
    const envelope = z.object({ errors: z.array(z.unknown()).optional(), data: z.object({ repository: z.object({ pullRequest: prSchema.nullable() }).nullable() }).optional() }).parse(raw);
    if (envelope.errors?.length || !envelope.data?.repository?.pullRequest) throw new ProviderError('GitHub query failed; check PR access and gh authentication.');
    const pr = envelope.data.repository.pullRequest;
    const [repo, number] = id.split('#');
    const review = pr.reviews.nodes[0];
    return { title: pr.title, url: `https://github.com/${repo}/pull/${number}`, state: pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase(), updatedAt: pr.updatedAt,
      fields: { commit: pr.headRefOid.slice(0, 12), comments: `${pr.comments.totalCount}${pr.comments.nodes[0] ? ` (latest ${pr.comments.nodes[0].updatedAt})` : ''}`, reviews: `${pr.reviews.totalCount}${review ? ` (${review.author?.login ?? 'unknown'}: ${review.state.toLowerCase()} at ${review.submittedAt ?? 'pending'})` : ''}`, 'review decision': pr.reviewDecision?.toLowerCase() ?? '', checks: pr.commits.nodes[0]?.commit.statusCheckRollup?.state.toLowerCase() ?? '', assignees: pr.assignees.nodes.map(x => x.login).sort().join(', '), labels: pr.labels.nodes.map(x => x.name).sort().join(', ') } };
  }
  const envelope = z.object({ errors: z.array(z.unknown()).optional(), data: z.object({ issue: issueSchema.nullable() }).optional() }).parse(raw);
  if (envelope.errors?.length || !envelope.data?.issue) throw new ProviderError('Linear query failed; check the issue ID and CLI workspace access.');
  const issue = envelope.data.issue;
  return { title: issue.title, url: issue.url, state: issue.state.name, updatedAt: issue.updatedAt, fields: { assignee: issue.assignee?.name ?? '', priority: ['none', 'urgent', 'high', 'medium', 'low'][issue.priority] ?? String(issue.priority), labels: issue.labels.nodes.map(x => x.name).sort().join(', '), 'latest comment': issue.comments.nodes[0]?.updatedAt ?? '' } };
}
