import multer from 'multer';
import type { ErrorRequestHandler } from 'express';
import { ApiError } from '../../core/http/api-error.js';
import { assistantImageInfo, MAX_AI_IMAGE_BYTES } from './image-policy.js';
export function validateAssistantImage(buffer: Buffer) {
  if (!buffer.length || buffer.length >= MAX_AI_IMAGE_BYTES) throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Optimize each AI image below 1 MB before uploading.');
  const info = assistantImageInfo(buffer);
  if (!info) throw new ApiError(400, 'INVALID_IMAGE', 'Attach a static JPG, PNG or WebP image no larger than 1,600 pixels per side.');
  return info.type;
}
export const assistantUpload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: MAX_AI_IMAGE_BYTES - 1, fields: 2, fieldSize: 10000, parts: 5 } }).array('files', 3);
export const assistantUploadError: ErrorRequestHandler = (error, _req, _res, next) => {
  if (error instanceof multer.MulterError) return next(new ApiError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'INVALID_ATTACHMENTS', 'Attach up to 3 optimized JPG, PNG or WebP images below 1 MB each with a question of at most 2,000 characters.'));
  next(error);
};
