import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { stopRecurringSchedulesCron, startRecurringSchedulesCron } from "./core/cron/recurring-schedules.cron.js";
import { startCommunityRemindersCron, stopCommunityRemindersCron } from "./core/cron/community-reminders.cron.js";
import { verifyMailTransport } from "./core/mail/mailer.service.js";
import { prisma } from "./core/prisma/client.js";

const app = createApp();
startRecurringSchedulesCron();
startCommunityRemindersCron();

const server = app.listen(env.port, () => {
  console.log(`FundLedger API listening on http://localhost:${env.port}`);
  void verifyMailTransport();
});

async function shutdown() {
  stopRecurringSchedulesCron();
  stopCommunityRemindersCron();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
