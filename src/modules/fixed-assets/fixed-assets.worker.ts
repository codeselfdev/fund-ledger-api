import cron from 'node-cron';
import { prisma } from '../../core/prisma/client.js';
import { financialTransaction } from '../accounting/transaction.js';
import { completedMonth } from './fixed-assets.policy.js';
import { today } from '../billing/billing.policy.js';
import { postAsset } from './fixed-assets.service.js';
let task: ReturnType<typeof cron.schedule> | undefined, running = false;
export async function postDueDepreciation() {
    if (running)
        return;
    running = true;
    try {
        const through = completedMonth(today());
        let cursor: string | undefined;
        for (;;) {
            const rows = await prisma.fixedAsset.findMany({ where: { status: 'active', OR: [{ postedThrough: null }, { postedThrough: { lt: through } }] }, orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            if (!rows.length)
                break;
            for (const row of rows) {
                try {
                    await financialTransaction(async (tx) => { const fresh = await tx.fixedAsset.findFirst({ where: { id: row.id, status: 'active' } }); if (fresh)
                        await postAsset(tx, fresh, through); });
                }
                catch (error) {
                    console.error('[fixed-assets] Depreciation failed', row.id, error);
                }
            }
            cursor = rows[rows.length - 1].id;
        }
    }
    finally {
        running = false;
    }
}
export function startFixedAssetsWorker() { if (task)
    return; task = cron.schedule('15 0 * * *', () => void postDueDepreciation().catch(e => console.error('[fixed-assets]', e)), { timezone: 'Asia/Dhaka' }); void postDueDepreciation().catch(e => console.error('[fixed-assets]', e)); }
export function stopFixedAssetsWorker() { task?.stop(); task = undefined; }
