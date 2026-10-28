import { createHash } from 'node:crypto';
import { z } from 'zod';

export const draftSchema = z.object({
  audience: z.enum(['all', 'due', 'staff', 'pick']),
  recipient_ids: z.array(z.string().min(1)).max(5000).default([]),
  push: z.boolean().default(true), email: z.boolean().default(false),
  title: z.string().trim().min(3).max(65), body: z.string().trim().min(3).max(500),
  image_file_id: z.string().min(1).max(100).optional(),
  destination: z.enum(['none', 'dues', 'schedules', 'notices', 'pay']).default('none'),
}).superRefine((draft, ctx) => {
  if (draft.audience === 'pick' && !draft.recipient_ids.length) ctx.addIssue({ code: 'custom', path: ['recipient_ids'], message: 'Choose at least one member' });
});
export type Draft = z.infer<typeof draftSchema>;
export type Recipient = { id: string; memberId: string | null; userId: string | null; name: string; email: string | null; push: boolean; due: number; staff: boolean };
export const audienceLabels = { all: 'All members', due: 'Members with dues', staff: 'Staff', pick: 'Selected members' };
export function selectAudience(people: Recipient[], draft: Pick<Draft, 'audience' | 'recipient_ids'>) {
  const selected = new Set(draft.recipient_ids);
  return people.filter(p => draft.audience === 'pick' ? selected.has(p.id) : draft.audience === 'staff' ? p.staff : p.memberId && (draft.audience === 'all' || p.due > 0));
}
export function reachFor(people: Recipient[], push: boolean, email: boolean) {
  return { total: people.length, inbox: people.filter(p => p.userId).length, push: push ? people.filter(p => p.userId && p.push).length : 0,
    email: email ? people.filter(p => p.email).length : 0, unreached: people.filter(p => !p.userId && !(email && p.email)).length };
}
export function fillMessage(text: string, recipient: Pick<Recipient, 'name' | 'due'>, project: string) {
  const values: Record<string, string> = { first_name: recipient.name.trim().split(/\s+/)[0] || 'Member', due_amount: `৳${recipient.due.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, project };
  return text.replace(/\{(first_name|due_amount|project)\}/g, (_, key: string) => values[key]!);
}
export function reviewToken(projectId: string, draft: Draft, recipients: Recipient[]) {
  return createHash('sha256').update(JSON.stringify({ projectId, draft: { ...draft, recipient_ids: [...draft.recipient_ids].sort() },
    recipients: [...recipients].sort((a, b) => a.id.localeCompare(b.id)) })).digest('hex');
}
