import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { prisma } from "../core/prisma/client.js";
import { getStorageMode, storeObject, verifyObjectStorage } from "../core/storage/object-storage.service.js";

function localPath(storageKey: string) {
  const root = path.resolve(process.cwd(), env.uploadLocalDir);
  const filePath = path.resolve(root, storageKey);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!filePath.startsWith(rootPrefix)) throw new Error(`Unsafe storage key: ${storageKey}`);
  return filePath;
}

function purposeFolder(purpose: string | null) {
  if (purpose?.startsWith("member_document")) return "member_document";
  if (purpose?.startsWith("member_photo")) return "member_photo";
  const folder = (purpose ?? "general")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return folder || "general";
}

function canonicalStorageKey(upload: {
  tenantId: string;
  projectId: string;
  storageKey: string;
  purpose: string | null;
}) {
  const prefix = `${upload.tenantId}/${upload.projectId}/`;
  const folder = purposeFolder(upload.purpose);
  const expectedPrefix = `${prefix}${folder}/`;
  if (upload.storageKey.startsWith(expectedPrefix)) return upload.storageKey;
  return `${expectedPrefix}${path.basename(upload.storageKey)}`;
}

async function main() {
  if (getStorageMode() !== "r2") {
    throw new Error("Set UPLOAD_STORAGE=r2 and configure R2 before running this migration");
  }
  await verifyObjectStorage();

  const uploads = await prisma.upload.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      tenantId: true,
      projectId: true,
      storageKey: true,
      mimeType: true,
      purpose: true,
    },
  });
  let migrated = 0;
  let missing = 0;

  for (const upload of uploads) {
    let buffer: Buffer;
    try {
      buffer = await readFile(localPath(upload.storageKey));
    } catch {
      missing += 1;
      continue;
    }
    const nextStorageKey = canonicalStorageKey(upload);
    await storeObject({
      storageKey: nextStorageKey,
      buffer,
      contentType: upload.mimeType,
    });
    if (nextStorageKey !== upload.storageKey) {
      await prisma.upload.update({
        where: { id: upload.id },
        data: { storageKey: nextStorageKey },
      });
    }
    migrated += 1;
    console.log(`[storage-migration] uploaded ${nextStorageKey}`);
  }

  console.log(`[storage-migration] complete: ${migrated} uploaded, ${missing} without a local source file`);
}

main()
  .catch((error) => {
    console.error("[storage-migration] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
