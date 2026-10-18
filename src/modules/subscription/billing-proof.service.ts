import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, notFound } from '../../core/http/api-error.js';
import { readObject, StorageObjectNotFoundError } from '../../core/storage/object-storage.service.js';
import { screenshotType } from '../support/support.service.js';

export const billingPaymentSchema = z.object({
  payment_reference: z.string().trim().min(3).max(200),
  payment_amount: z.coerce.number().int().positive().max(2147483647),
  request_key: z.string().uuid(),
}).strict();
export type BillingPaymentInput = z.infer<typeof billingPaymentSchema>;
export type BillingReceiptFile = { originalname: string; buffer: Buffer; size: number };
export function billingReceipt(file?: BillingReceiptFile) {
  if (!file) throw badRequest('Attach a receipt image or PDF with the amount and transaction reference.');
  if (file.size < 1 || file.size > 5_000_000 || file.size !== file.buffer.length) throw badRequest('The receipt must be between 1 byte and 5 MB.');
  const mimeType = file.buffer.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : screenshotType(file.buffer);
  return { id: randomUUID(), fileName: file.originalname.replace(/[\r\n\\/]/g, '_').slice(0, 180) || 'payment-receipt', mimeType, size: file.size,
    contentHash: createHash('sha256').update(file.buffer).digest('hex') };
}
export async function sendBillingReceipt(req: Request, res: Response, tenantId: string, invoiceId: string, receiptId: string) {
  const receipt = await prisma.subscriptionPaymentReceipt.findFirst({ where: { id: receiptId, tenantId, invoiceId } });
  if (!receipt) throw notFound('Billing receipt not found.');
  try {
    const object = await readObject(receipt.storageKey);
    res.set({ 'Content-Type': receipt.mimeType, 'Content-Length': String(object.buffer.length), 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename="${receipt.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"` });
    return res.send(object.buffer);
  } catch (error) { if (error instanceof StorageObjectNotFoundError) throw notFound('Billing receipt content not found.'); throw error; }
}
