import { z } from 'zod';
export { platformSchema, type Platform } from './providers';
export const snapshotSchema = z.object({
  title: z.string().max(1000), url: z.string().url(), state: z.string().max(200),
  updatedAt: z.string(), fields: z.record(z.string(), z.string().max(2000)),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const subscriptionSchema = z.object({
  platform: z.string(), id: z.string(), snapshot: snapshotSchema.nullable(),
  error: z.string().nullable(), checkedAt: z.number().nullable(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
const clean = (s: string) => s.replace(/[\r\n\t]/g, ' ').replace(/[\[\]<>`()]/g, '').slice(0, 180);
/** One item's changes between two snapshots, or null when nothing the plugin tracks changed. */
export function describe(id: string, before: Snapshot, after: Snapshot): string | null {
  const changes: string[] = [];
  if (before.state !== after.state) changes.push(`${clean(before.state)} → ${clean(after.state)}`);
  if (before.title !== after.title) changes.push('title updated');
  for (const key of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    if (before.fields[key] !== after.fields[key]) changes.push(`${clean(key)}: ${clean(before.fields[key] || 'none')} → ${clean(after.fields[key] || 'none')}`);
  }
  if (!changes.length) return null;
  return `[${clean(id)}](${after.url}): ${changes.slice(0, 5).join('; ')}${changes.length > 5 ? '; other fields updated' : ''}.`;
}
/** The message for one or more changed items. Null when no line survives. */
export function compose(lines: string[]): string | null {
  if (!lines.length) return null;
  if (lines.length === 1) return `[Subscription update] ${lines[0]}`;
  return `[Subscription update]\n${lines.map(line => `- ${line}`).join('\n')}`;
}
