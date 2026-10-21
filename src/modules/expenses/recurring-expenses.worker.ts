import cron, { type ScheduledTask } from 'node-cron';
import { runRecurringExpenses } from './recurring-expenses.service.js';
let task: ScheduledTask | null = null;
let running = false;
async function run() {
  if (running) return;
  running = true;
  try { await runRecurringExpenses(); }
  catch (error) { console.error('[recurring-expenses] worker failed', error); }
  finally { running = false; }
}
export function startRecurringExpensesWorker() {
  if (!task) { task = cron.schedule('*/5 * * * *', () => { void run(); }, { timezone: 'Asia/Dhaka' }); void run(); }
  return task;
}
export function stopRecurringExpensesWorker() { task?.stop(); task = null; }
