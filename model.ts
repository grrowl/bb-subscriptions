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
/** Summarise what changed between two snapshots, or null when nothing did. */
export function describe(id: string, before: Snapshot, after: Snapshot): string | null {
  const changes: string[] = [];
  if (before.state !== after.state) changes.push(`${clean(before.state)} → ${clean(after.state)}`);
  if (before.title !== after.title) changes.push('title updated');
  for (const key of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
    if (before.fields[key] !== after.fields[key]) changes.push(`${clean(key)}: ${clean(before.fields[key] || 'none')} → ${clean(after.fields[key] || 'none')}`);
  }
  if (!changes.length && before.updatedAt !== after.updatedAt) changes.push('updated');
  if (!changes.length) return null;
  return `[Subscription update] [${clean(id)}](${after.url}): ${changes.slice(0, 5).join('; ')}${changes.length > 5 ? '; other fields updated' : ''}.`;
}
