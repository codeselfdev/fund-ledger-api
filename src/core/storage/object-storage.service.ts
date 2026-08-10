import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";

export class StorageObjectNotFoundError extends Error {
  constructor(message = "Storage object not found") {
    super(message);
    this.name = "StorageObjectNotFoundError";
  }
}

type ReadObjectResult = {
  buffer: Buffer;
  contentType?: string;
};

const localUploadRoot = path.resolve(process.cwd(), env.uploadLocalDir);
let cachedR2Client: S3Client | null = null;

function resolveLocalUploadPath(storageKey: string) {
  const absolutePath = path.resolve(localUploadRoot, storageKey);
  const rootPrefix = localUploadRoot.endsWith(path.sep) ? localUploadRoot : `${localUploadRoot}${path.sep}`;
  if (absolutePath !== localUploadRoot && !absolutePath.startsWith(rootPrefix)) {
    throw new Error("Invalid upload path");
  }
  return absolutePath;
}

function getR2Config() {
  const accountId = env.uploadR2.accountId;
  const accessKeyId = env.uploadR2.accessKeyId;
  const secretAccessKey = env.uploadR2.secretAccessKey;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("R2 storage is selected but R2 credentials are missing");
  }

  const endpointInput = env.uploadR2.endpoint ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!endpointInput) {
    throw new Error("R2 storage is selected but no endpoint/account id is configured");
  }

  let endpoint = endpointInput;
  let bucketFromEndpoint: string | undefined;
  try {
    const parsed = new URL(endpointInput);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    if (pathParts.length > 1) {
      throw new Error("R2 endpoint should not contain nested path segments");
    }
    bucketFromEndpoint = pathParts[0];
    endpoint = parsed.origin;
  } catch {
    throw new Error("R2 endpoint must be a valid URL");
  }

  const bucket = env.uploadR2.bucket ?? bucketFromEndpoint;
  if (!bucket) {
    throw new Error("R2 bucket is required (set R2_BUCKET or provide /bucket in R2_ENDPOINT)");
  }
  if (bucketFromEndpoint && env.uploadR2.bucket && bucketFromEndpoint !== env.uploadR2.bucket) {
    throw new Error("R2 endpoint bucket path does not match R2_BUCKET");
  }

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket
  };
}

function getR2Client() {
  if (cachedR2Client) return cachedR2Client;
  const config = getR2Config();
  cachedR2Client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    forcePathStyle: true
  });
  return cachedR2Client;
}

function getStorageMode() {
  if (env.uploadStorage === "local") return "local";
  if (env.uploadStorage === "r2") return "r2";
  throw new Error(`Unsupported UPLOAD_STORAGE value: ${env.uploadStorage}`);
}

async function streamToBuffer(body: unknown) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);

  const bodyWithTransform = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof bodyWithTransform.transformToByteArray === "function") {
    const byteArray = await bodyWithTransform.transformToByteArray();
    return Buffer.from(byteArray);
  }

  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string | Buffer>) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported object stream type");
}

export async function storeObject(input: { storageKey: string; buffer: Buffer; contentType?: string }) {
  const mode = getStorageMode();
  if (mode === "local") {
    const filePath = resolveLocalUploadPath(input.storageKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.buffer);
    return;
  }

  const config = getR2Config();
  const client = getR2Client();
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: input.storageKey,
    Body: input.buffer,
    ContentType: input.contentType
  }));
}

export async function readObject(storageKey: string): Promise<ReadObjectResult> {
  const mode = getStorageMode();
  if (mode === "local") {
    const filePath = resolveLocalUploadPath(storageKey);
    try {
      return {
        buffer: await readFile(filePath)
      };
    } catch {
      throw new StorageObjectNotFoundError();
    }
  }

  const config = getR2Config();
  const client = getR2Client();
  try {
    const result = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: storageKey
    }));
    if (!result.Body) throw new StorageObjectNotFoundError();
    return {
      buffer: await streamToBuffer(result.Body),
      contentType: result.ContentType
    };
  } catch (error) {
    const maybeName = (error as { name?: string }).name;
    const maybeCode = (error as { Code?: string }).Code;
    const maybeStatus = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (maybeName === "NoSuchKey" || maybeCode === "NoSuchKey" || maybeStatus === 404) {
      throw new StorageObjectNotFoundError();
    }
    throw error;
  }
}

export async function deleteObject(storageKey: string) {
  const mode = getStorageMode();
  if (mode === "local") {
    const filePath = resolveLocalUploadPath(storageKey);
    await unlink(filePath).catch(() => undefined);
    return;
  }

  const config = getR2Config();
  const client = getR2Client();
  await client.send(new DeleteObjectCommand({
    Bucket: config.bucket,
    Key: storageKey
  })).catch(() => undefined);
}
