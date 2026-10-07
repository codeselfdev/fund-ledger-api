import cron, { type ScheduledTask } from "node-cron";
import { runCommunityReminders } from "../../modules/community/community-reminders.service.js";

let task: ScheduledTask | null = null;

export function startCommunityRemindersCron() {
  if (task) return task;
  task = cron.schedule("* * * * *", () => {
    void runCommunityReminders();
  });
  void runCommunityReminders();
  return task;
}

export function stopCommunityRemindersCron() {
  if (!task) return;
  task.stop();
  task = null;
}
