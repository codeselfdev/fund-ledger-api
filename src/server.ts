import { startDocumentRetentionCron, stopDocumentRetentionCron } from "./core/cron/document-retention.cron.js";
import { startFixedAssetsWorker, stopFixedAssetsWorker } from './modules/fixed-assets/fixed-assets.worker.js';
import { startReportsWorker, stopReportsWorker } from "./modules/reports/report.worker.js";
import { startCampaignWorker, stopCampaignWorker } from "./modules/notification-campaigns/campaign.service.js";
import { startBillingWorker, stopBillingWorker } from "./modules/billing/billing.worker.js";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { stopRecurringSchedulesCron, startRecurringSchedulesCron } from "./core/cron/recurring-schedules.cron.js";
import { startCommunityRemindersCron, stopCommunityRemindersCron } from "./core/cron/community-reminders.cron.js";
import { startPaymentCommitmentsCron, stopPaymentCommitmentsCron } from "./core/cron/payment-commitments.cron.js";
import { verifyMailTransport } from "./core/mail/mailer.service.js";
import { prisma } from "./core/prisma/client.js";
import { verifyObjectStorage } from "./core/storage/object-storage.service.js";

import { startAssistantWorker, stopAssistantWorker } from "./modules/assistant/assistant.worker.js";
const app = createApp();
startAssistantWorker();
startRecurringSchedulesCron();
startDocumentRetentionCron();
startBillingWorker();
startCampaignWorker();
startReportsWorker();
startFixedAssetsWorker();
startCommunityRemindersCron();
startPaymentCommitmentsCron();

const server = app.listen(env.port, () => {
  console.log(`FundLedger API listening on http://localhost:${env.port}`);
  void verifyMailTransport();
  void verifyObjectStorage()
    .then((storage) => console.log(`[storage] ${storage.mode} verified${storage.bucket ? ` (${storage.bucket})` : ""}`))
    .catch((error) => console.error(`[storage] ${env.uploadStorage} verification failed`, error));
});

async function shutdown() {
  stopAssistantWorker();
  stopRecurringSchedulesCron();
  stopDocumentRetentionCron();
  stopBillingWorker();
  stopCampaignWorker();
  stopReportsWorker();
  stopFixedAssetsWorker();
  stopCommunityRemindersCron();
  stopPaymentCommitmentsCron();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
