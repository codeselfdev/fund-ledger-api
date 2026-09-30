import { getMessaging } from "firebase-admin/messaging";
import { getFirebaseAdminApp, getFirebaseAdminInitError } from "../firebase/admin.js";

type PushMessageInput = {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
};

type PushMessageResult = {
  sent_count: number;
  failed_count: number;
  invalid_tokens: string[];
  skipped: boolean;
  reason?: string;
};

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export async function sendPushMessage(input: PushMessageInput): Promise<PushMessageResult> {
  const uniqueTokens = [...new Set(input.tokens.filter((token) => token.trim().length > 0))];
  if (uniqueTokens.length === 0) {
    return {
      sent_count: 0,
      failed_count: 0,
      invalid_tokens: [],
      skipped: true,
      reason: "no_recipient_tokens"
    };
  }

  const app = getFirebaseAdminApp();
  if (!app) {
    return {
      sent_count: 0,
      failed_count: uniqueTokens.length,
      invalid_tokens: [],
      skipped: true,
      reason: getFirebaseAdminInitError() ?? "fcm_not_configured"
    };
  }

  let sentCount = 0;
  let failedCount = 0;
  const invalidTokens: string[] = [];

  for (const tokenGroup of chunks(uniqueTokens, 500)) {
    const batch = await getMessaging(app).sendEachForMulticast({
      tokens: tokenGroup,
      notification: {
        title: input.title,
        body: input.body
      },
      data: input.data
    });

    sentCount += batch.successCount;
    failedCount += batch.failureCount;
    batch.responses.forEach((response, index) => {
      if (response.success) return;
      const code = response.error?.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        invalidTokens.push(tokenGroup[index] as string);
      }
    });
  }

  return {
    sent_count: sentCount,
    failed_count: failedCount,
    invalid_tokens: [...new Set(invalidTokens)],
    skipped: false
  };
}
