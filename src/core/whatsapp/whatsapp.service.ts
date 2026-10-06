import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { badRequest } from "../http/api-error.js";
import { prisma } from "../prisma/client.js";
import { env } from "../../config/env.js";

function encryptionKey() {
  const secret = process.env.WHATSAPP_CREDENTIALS_KEY || process.env.JWT_SECRET;
  if (!secret) throw badRequest("WHATSAPP_CREDENTIALS_KEY must be configured before connecting WhatsApp");
  return createHash("sha256").update(secret).digest();
}

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function decrypt(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid encrypted WhatsApp credential");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64")), decipher.final()]).toString("utf8");
}

async function graphRequest<T>(input: {
  version: string;
  path: string;
  token: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<T> {
  const response = await fetch(`https://graph.facebook.com/${input.version}/${input.path.replace(/^\//, "")}`, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/json",
      ...(input.body ? { "Content-Type": "application/json" } : {})
    },
    body: input.body ? JSON.stringify(input.body) : undefined
  });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw badRequest(payload.error?.message || `WhatsApp Graph API request failed (${response.status})`);
  return payload;
}

export async function connectWhatsApp(input: {
  tenantId: string;
  projectId: string;
  actorUserId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  graphApiVersion: string;
}) {
  if (!env.whatsapp.enabled) throw badRequest("WhatsApp integration is currently disabled");
  const phone = await graphRequest<{ display_phone_number?: string; verified_name?: string }>({
    version: input.graphApiVersion,
    path: `${input.phoneNumberId}?fields=display_phone_number,verified_name`,
    token: input.accessToken
  });
  const connection = await prisma.whatsAppConnection.upsert({
    where: { projectId: input.projectId },
    update: {
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: phone.display_phone_number,
      verifiedName: phone.verified_name,
      graphApiVersion: input.graphApiVersion,
      encryptedAccessToken: encrypt(input.accessToken),
      isActive: true,
      lastVerifiedAt: new Date()
    },
    create: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: phone.display_phone_number,
      verifiedName: phone.verified_name,
      graphApiVersion: input.graphApiVersion,
      encryptedAccessToken: encrypt(input.accessToken),
      isActive: true,
      lastVerifiedAt: new Date(),
      createdById: input.actorUserId
    }
  });
  return publicConnection(connection);
}

export async function mapWhatsAppGroup(input: {
  tenantId: string;
  projectId: string;
  groupId: string;
  groupName: string;
}) {
  if (!env.whatsapp.enabled) throw badRequest("WhatsApp integration is currently disabled");
  const connection = await prisma.whatsAppConnection.findFirst({
    where: { tenantId: input.tenantId, projectId: input.projectId, isActive: true }
  });
  if (!connection) throw badRequest("Connect an eligible WhatsApp Business account first");
  await graphRequest({
    version: connection.graphApiVersion,
    path: input.groupId,
    token: decrypt(connection.encryptedAccessToken)
  });
  return publicConnection(await prisma.whatsAppConnection.update({
    where: { id: connection.id },
    data: { groupId: input.groupId, groupName: input.groupName }
  }));
}

export async function getWhatsAppConnection(tenantId: string, projectId: string) {
  if (!env.whatsapp.enabled) return null;
  const connection = await prisma.whatsAppConnection.findFirst({ where: { tenantId, projectId } });
  return connection ? publicConnection(connection) : null;
}

export async function disconnectWhatsApp(tenantId: string, projectId: string) {
  const result = await prisma.whatsAppConnection.deleteMany({ where: { tenantId, projectId } });
  return { disconnected: result.count > 0 };
}

export async function sendWhatsAppGroupMessage(input: { tenantId: string; projectId: string; message: string }) {
  if (!env.whatsapp.enabled) return { sent: false, skipped: "disabled" as const };
  const connection = await prisma.whatsAppConnection.findFirst({
    where: { tenantId: input.tenantId, projectId: input.projectId, isActive: true }
  });
  if (!connection?.groupId) return { sent: false, skipped: "not_configured" as const };
  try {
    const response = await graphRequest<{ messages?: Array<{ id: string }> }>({
      version: connection.graphApiVersion,
      path: `${connection.phoneNumberId}/messages`,
      token: decrypt(connection.encryptedAccessToken),
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "group",
        to: connection.groupId,
        type: "text",
        text: { body: input.message, preview_url: false }
      }
    });
    return { sent: true, message_id: response.messages?.[0]?.id ?? null };
  } catch (error) {
    console.error("[whatsapp] group message failed", error);
    return { sent: false, error: error instanceof Error ? error.message : "WhatsApp delivery failed" };
  }
}

function publicConnection(connection: {
  id: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  graphApiVersion: string;
  groupId: string | null;
  groupName: string | null;
  isActive: boolean;
  lastVerifiedAt: Date | null;
}) {
  return {
    id: connection.id,
    connected: connection.isActive,
    waba_id: connection.wabaId,
    phone_number_id: connection.phoneNumberId,
    display_phone_number: connection.displayPhoneNumber,
    verified_name: connection.verifiedName,
    graph_api_version: connection.graphApiVersion,
    group: connection.groupId ? { id: connection.groupId, name: connection.groupName } : null,
    last_verified_at: connection.lastVerifiedAt
  };
}
