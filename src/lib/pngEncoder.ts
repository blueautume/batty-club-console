/** PNG primitives kept independent of DOM so the actual encoded stream can be verified. */
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export function pngCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
export function pngChunk(type: 'IHDR' | 'IDAT' | 'IEND', data: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(data.length + 12), view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8); view.setUint32(chunk.length - 4, pngCrc32(chunk.subarray(4, chunk.length - 4)));
  return chunk;
}
export function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) throw new Error('PNG图片尺寸无效');
  const data = new Uint8Array(13), view = new DataView(data.buffer);
  view.setUint32(0, width); view.setUint32(4, height); data.set([8, 6, 0, 0, 0], 8);
  return pngChunk('IHDR', data);
}
export function pngFilterRows(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array<ArrayBuffer> {
  const rowBytes = width * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length !== rowBytes * height) throw new Error('PNG像素数据尺寸不一致');
  const filtered = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row++) filtered.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
  return filtered;
}

/** One PNG, streamed in bounded-height bands instead of allocating a giant canvas. */
export async function encodePngBands(width: number, height: number, readBand: (top: number, height: number) => Uint8ClampedArray | Promise<Uint8ClampedArray>, bandHeight = 512): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') throw new Error('当前浏览器不支持超长图片生成，请使用新版Chrome、Edge或Safari后重试');
  if (!Number.isInteger(bandHeight) || bandHeight <= 0) throw new Error('PNG分带高度无效');
  const header = pngHeader(width, height);
  const compression = new CompressionStream('deflate'), writer = compression.writable.getWriter();
  const parts: BlobPart[] = [PNG_SIGNATURE, header];
  const collect = (async () => {
    const reader = compression.readable.getReader();
    try { while (true) { const { value, done } = await reader.read(); if (done) break; parts.push(pngChunk('IDAT', value)); } }
    finally { reader.releaseLock(); }
  })();
  // Attach a rejection handler immediately; the writer may fail before the collection is awaited.
  void collect.catch(() => {});
  try {
    for (let top = 0; top < height; top += bandHeight) {
      const rows = Math.min(bandHeight, height - top);
      await writer.write(pngFilterRows(await readBand(top, rows), width, rows));
    }
    await writer.close(); await collect;
    parts.push(pngChunk('IEND', new Uint8Array()));
    return new Blob(parts, { type: 'image/png' });
  } catch (error) {
    await writer.abort(error).catch(() => {}); await collect.catch(() => {}); throw error;
  } finally { writer.releaseLock(); }
}
