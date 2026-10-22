export const MAX_AI_IMAGE_BYTES = 1_000_000;
export const MAX_AI_IMAGE_SIDE = 1600;
// Read dimensions before handing untrusted bytes to the image model. No SVG or animation.
export function assistantImageInfo(b: Buffer) {
  let type: string | undefined, width: number | undefined, height: number | undefined;
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16) === 'IHDR') {
    type = 'image/png'; width = b.readUInt32BE(16); height = b.readUInt32BE(20);
    let end = 8;
    while (end + 12 <= b.length) {
      const length = b.readUInt32BE(end), name = b.toString('ascii', end + 4, end + 8);
      if (name === 'acTL' || end + length + 12 > b.length) return null;
      end += length + 12;
      if (name === 'IEND') break;
    }
  } else if (b.length >= 12 && b[0] === 255 && b[1] === 216 && b[2] === 255) {
    type = 'image/jpeg'; let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 255) return null;
      while (b[offset] === 255) offset++;
      const marker = b[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > b.length) return null;
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) return null;
        height = b.readUInt16BE(offset + 3); width = b.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (b.length >= 30 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') {
    type = 'image/webp';
    const kind = b.toString('ascii',12,16);
    if (kind === 'VP8X') {
      if (b[20] & 2) return null;
      width = 1 + b.readUIntLE(24,3); height = 1 + b.readUIntLE(27,3);
    } else if (kind === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) {
      width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
    }
  }
  if (!type || !width || !height || width > MAX_AI_IMAGE_SIDE || height > MAX_AI_IMAGE_SIDE) return null;
  return { type, width, height };
}
