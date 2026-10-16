import cron, { type ScheduledTask } from "node-cron";
import { cleanupRetainedDocuments } from "../subscription/document-retention.js";
let task: ScheduledTask | null = null;
let running = false;
export function startDocumentRetentionCron() {
  if (task) return task;
  task = cron.schedule("20 * * * *", async () => {
    if (running) return;
    running = true;
    try { await cleanupRetainedDocuments(); }
    catch (error) { console.error("[documents] retention cleanup failed", error); }
    finally { running = false; }
  }, { timezone: "Asia/Dhaka" });
  return task;
}
export function stopDocumentRetentionCron() { task?.stop(); task = null; }
