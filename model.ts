import { z } from 'zod';
export const platformSchema = z.enum(['github', 'linear']);
export type Platform = z.infer<typeof platformSchema>;
export const snapshotSchema = z.object({
  title: z.string().max(1000), url: z.string().url(), state: z.string().max(200),
  updatedAt: z.string(), fields: z.record(z.string(), z.string().max(2000)),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const subscriptionSchema = z.object({
  platform: platformSchema, id: z.string(), snapshot: snapshotSchema.nullable(),
  error: z.string().nullable(), checkedAt: z.number().nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export function canonical(platform: Platform, raw: string, repo = ''): string {
  let id = raw.trim();
  if (platform === 'github') {
    const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/.exec(id);
    if (url) id = `${url[1]}#${url[2]}`;
    if (/^#?[1-9]\d*$/.test(id)) id = `${repo}#${id.replace('#', '')}`;
    if (!/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(id)) throw new Error('Use owner/repo#123 or a GitHub PR URL. Bare numbers work automatically in a project with a GitHub remote; otherwise set githubRepository.');
    return id.toLowerCase();
  }
  const url = /^https:\/\/linear\.app\/[^/]+\/issue\/([a-z0-9]+-[1-9]\d*)(?:[/?#].*)?$/i.exec(id);
  if (url) id = url[1];
  if (!/^[a-z][a-z0-9]*-[1-9]\d*$/i.test(id)) throw new Error('Use a Linear issue ID such as ENG-123 or its URL.');
  return id.toUpperCase();
}

/** Return the GitHub owner/repository part of a standard Git remote URL. */
export function githubRepositoryFromRemote(remote: string | null): string {
  if (remote === null) return '';
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match?.[1]?.toLowerCase() ?? '';
}
const clean = (s: string) => s.replace(/[\r\n\t]/g, ' ').replace(/[\[\]<>`]/g, '').slice(0, 180);
export function describe(id: string, before: Snapshot, after: Snapshot): string | null {
  const changes: string[] = [];
  if (before.state !== after.state) changes.push(`${clean(before.state)} → ${clean(after.state)}`);
  if (before.title !== after.title) changes.push('title updated');
  for (const key of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    if (before.fields[key] !== after.fields[key]) changes.push(`${clean(key)}: ${clean(before.fields[key] || 'none')} → ${clean(after.fields[key] || 'none')}`);
  }
  if (!changes.length && before.updatedAt !== after.updatedAt) changes.push('updated');
  if (!changes.length) return null;
  return `[Subscription update] ${id}: ${changes.slice(0, 5).join('; ')}${changes.length > 5 ? '; other fields updated' : ''}. ${after.url}`;
}
