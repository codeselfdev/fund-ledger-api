import { badRequest } from "../http/api-error.js";

export const MAX_UPLOAD_IMAGE_BYTES = 2_000_000;

/** Check before writing an image to local storage or R2. PDFs keep their existing limit. */
export function assertImageUploadSize(file: { mimetype: string; size: number; originalname: string }) {
  const image = file.mimetype.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.originalname);
  if (image && file.size >= MAX_UPLOAD_IMAGE_BYTES) {
    throw badRequest("Images must be smaller than 2 MB. Optimize the photo before uploading.");
  }
}
