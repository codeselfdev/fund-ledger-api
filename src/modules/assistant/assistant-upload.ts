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
// Three images plus message, request_key and optional reply_to_request_key.
// Busboy signals partsLimit when the count reaches its limit, so allow one
// sentinel part beyond those six. The separate file/field limits remain strict.
export const assistantUpload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: MAX_AI_IMAGE_BYTES, fields: 3, fieldSize: 10000, parts: 7 } }).array('files', 3);
export const assistantUploadError: ErrorRequestHandler = (error, _req, _res, next) => {
  if (!(error instanceof multer.MulterError)) return next(error);
  if (error.code === 'LIMIT_FILE_SIZE') return next(new ApiError(413, 'IMAGE_TOO_LARGE', 'Optimize each AI image below 1 MB before uploading.'));
  const message = error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE'
    ? 'Attach up to 3 JPG, PNG or WebP images per question.'
    : error.code === 'LIMIT_FIELD_VALUE'
      ? 'The question or request details are too long. Keep the question within 2,000 characters.'
      : error.code === 'LIMIT_FIELD_COUNT' || error.code === 'LIMIT_PART_COUNT'
        ? 'This upload has too many request fields. Start a new question and attach up to 3 images.'
        : 'The image upload could not be read. Choose JPG, PNG or WebP images and try again.';
  next(new ApiError(400, 'INVALID_ATTACHMENTS', message));
};
