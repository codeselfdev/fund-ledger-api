import { createHash } from 'node:crypto';
import { z } from 'zod';
import knowledge from './knowledge.json' with { type: 'json' };
import { availableForAccess } from '../shortcuts/shortcuts.access.js';
import type { MenuPermissions } from '../../core/security/menu-access.js';
export const GUIDE_LIMIT = 20;
export const guideBody = z.object({ question: z.string().trim().min(2).max(1000), language: z.enum(['en','bn']), request_key: z.string().uuid() }).strict();
export const guidePlan = z.object({ kind: z.enum(['guide','not_supported','not_permitted','private_data']), topic_ids: z.array(z.string().max(80)).max(4) }).strict();
export type GuidePlan = z.infer<typeof guidePlan>;
export type Language = 'en' | 'bn';
export interface Article { id: string; title: string; summary: string; why: string; steps: string[]; options?: string[]; path: string; related: string[]; group: string; projectType?: string; }
type GuideAccess = { menu:string; roles:string[]; writeRoles?:string[]; builtinOnly?:boolean; viewOnly?:boolean };
type PublicProject = { articles: Record<string,Record<Language,Article>>; roles: Record<string,string[]>; access?:Record<string,GuideAccess>; readOnly?:Record<string,Record<Language,string[]>> };
export const publicKnowledge = knowledge.projects as Record<string,PublicProject>;
export const guideConfigured = () => process.env.APP_GUIDE_AI_ENABLED !== 'false' && !!process.env.OPENAI_API_KEY?.trim() && !!(process.env.APP_GUIDE_AI_MODEL || process.env.OPENAI_CHAT_MODEL)?.trim();
const settings = new Set(['business_setup','project_details','tax_pricing','pdf_template','pdf_item_details','item_fields','customer_fields','dealer_fields','item_search','customer_search','dealer_search']);
const guideAccess = (id:string) => (id.startsWith('institute_')?publicKnowledge.institute:publicKnowledge.fund_shares)?.access?.[id];
export function articleMenu(id: string) {
  if (guideAccess(id)) return guideAccess(id)!.menu;
  if (settings.has(id)) return 'business_setup';
  return ({ bulk_payment:'members', recurring_expenses:'expenses', quick_sale:'sale', stock_settings:'inventory', member_followups:'followups', construction_reviews:'construction_approvals' } as Record<string,string>)[id] ?? id;
}
function canWrite(id: string, roles: string[], permissions?: MenuPermissions) {
  const rule=guideAccess(id);
  if (rule?.writeRoles) return rule.writeRoles.some(role=>roles.includes(role)) || !rule.builtinOnly && permissions?.[rule.menu]?.write===true;
  if (roles.some(role => ['owner','admin'].includes(role))) return true;
  if (permissions?.[articleMenu(id)]?.write) return true;
  if (settings.has(id)) return false;
  if (roles.includes('accountant') && !['roles','activity','reports','integrations','payroll_settings','payroll_import'].includes(id)) return true;
  if (roles.includes('cashier') && ['income','expenses','members','bulk_payment','billing_collections','quick_sale'].includes(id)) return true;
  if (roles.includes('approver') && ['approvals','pending_expenses','pending_deposits','billing_approvals','construction_reviews','payroll_leave','payroll_bills'].includes(id)) return true;
  return roles.includes('member') && ['my_payment','payroll_attendance','payroll_leave','payroll_bills'].includes(id);
}
export function authorizedArticles(type: string, roles: string[], permissions: MenuPermissions | undefined, language: Language): Article[] {
  const project = publicKnowledge[type]; if (!project) return [];
  const defaults = new Set(roles.flatMap(role => project.roles[role] ?? []));
  const tools = new Set(availableForAccess(type,{roles,menuPermissions:permissions,customRoleOnly:roles.length===0}).tools.map(tool=>tool.key));
  const manage = roles.some(role=>['owner','admin'].includes(role)) || permissions?.business_setup?.write === true;
  const allowed = Object.values(project.articles).map(row=>row[language]).filter(article=>{
    const rule=project.access?.[article.id];
    if (rule?.builtinOnly && !rule.roles.some(role=>roles.includes(role))) return false;
    if (['overview','all_tools'].includes(article.id)) return true;
    if (article.id==='ai_sales_help') return roles.some(role=>['owner','admin','accountant'].includes(role));
    if (article.id==='project_details') return roles.some(role=>['owner','admin'].includes(role));
    if (settings.has(article.id)) return manage;
    if (!permissions) return defaults.has(article.id);
    return defaults.has(article.id) || tools.has(articleMenu(article.id)) || permissions[articleMenu(article.id)]?.read === true;
  });
  const visibleIds=new Set(allowed.map(article=>article.id));
  return allowed.map(article=>{
    const writable=canWrite(article.id,roles,permissions);
    const visible = writable || guideAccess(article.id)?.viewOnly || ['overview','all_tools'].includes(article.id) ? {...article} : {...article, options:type==='fund_shares'?project.readOnly?.[article.id]?.[language]:article.options, steps:language==='bn' ? [
      `${article.path} খুলে আপনার জন্য দেখানো হিসাব দেখুন।`,
      'তারিখ, খোঁজার ঘর বা ফিল্টার ব্যবহার করে দরকারি রেকর্ড খুলুন। অন্য মানুষের ব্যক্তিগত তথ্য এখানে চাওয়ার দরকার নেই।',
      'এই কাজে আপনার জন্য শুধু দেখার ধাপ দিলাম। কিছু যোগ, বদল বা অনুমোদন করতে হলে project-এর Owner / Admin-এর সঙ্গে কথা বলুন।',
    ] : [`Open ${article.path} and review the records available to you.`, 'Use the available search, dates or filters to inspect the relevant record.', 'This guide provides viewing steps for your access. Contact the project owner/admin if you need to add, change or approve records.']};
    return {...visible, related:article.related.filter(id=>visibleIds.has(id))};
  });
}
export function validatePlan(raw: unknown, articles: Article[]): GuidePlan {
  const plan=guidePlan.parse(raw), allowed=new Set(articles.map(a=>a.id));
  if (new Set(plan.topic_ids).size!==plan.topic_ids.length || plan.topic_ids.some(id=>!allowed.has(id)) || (plan.kind==='guide' && !plan.topic_ids.length) || (plan.kind!=='guide' && plan.topic_ids.length)) throw Error('Invalid guide selection');
  return plan;
}
export function redactGuideQuestion(value: string) {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/\+?\d[\d ()-]{7,}\d/g,'[number]').replace(/Bearer\s+\S+|sk-[\w-]{12,}/gi,'[secret]');
}
export const questionHash = (question:string, language:Language) => createHash('sha256').update(JSON.stringify([question,language])).digest('hex');
