import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { pngCrc32, pngChunk, pngHeader, pngFilterRows, encodePngBands } from '../src/lib/pngEncoder.ts';

function readChunks(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'PNG chunk header must be complete');
    const length = bytes.readUInt32BE(offset); const end = offset + 12 + length;
    assert.ok(end <= bytes.length, 'PNG chunk payload must be complete');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(end - 4), crc32(bytes.subarray(offset + 4, end - 4)), `${type} CRC must match an independent native implementation`);
    chunks.push({ type, data }); offset = end;
  }
  assert.equal(offset, bytes.length); assert.equal(chunks[0]?.type, 'IHDR'); assert.equal(chunks.at(-1)?.type, 'IEND');
  return chunks;
}

test('PNG CRC符合已知向量与Node独立原生CRC实现，IEND使用标准字节', () => {
  const data = new TextEncoder().encode('123456789');
  assert.equal(pngCrc32(data), 0xcbf43926); assert.equal(pngCrc32(data), crc32(data));
  assert.equal(pngCrc32(new Uint8Array()), 0);
  assert.equal(Buffer.from(pngChunk('IEND', new Uint8Array())).toString('hex'), '0000000049454e44ae426082');
});

test('PNG头固定8位RGBA、无交错，完整保存超过32767的长图高度', () => {
  const chunk = Buffer.from(pngHeader(1080, 50001));
  assert.equal(chunk.readUInt32BE(0), 13); assert.equal(chunk.toString('ascii', 4, 8), 'IHDR');
  assert.equal(chunk.readUInt32BE(8), 1080); assert.equal(chunk.readUInt32BE(12), 50001);
  assert.deepEqual([...chunk.subarray(16, 21)], [8, 6, 0, 0, 0]);
  assert.equal(chunk.readUInt32BE(21), crc32(chunk.subarray(4, 21)));
  for (const invalid of [0, -1, 1.5, NaN, Infinity, 0x80000000]) {
    assert.throws(() => pngHeader(invalid, 5), /尺寸/); assert.throws(() => pngHeader(5, invalid), /尺寸/);
  }
});

test('RGBA每行添加PNG过滤字节，不改变像素和透明度，拒绝不完整像素', () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 127, 126, 125, 124]);
  assert.deepEqual([...pngFilterRows(pixels, 2, 2)], [0, 255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 0, 255, 0, 127, 126, 125, 124]);
  assert.throws(() => pngFilterRows(pixels.subarray(0, 15), 2, 2), /尺寸/);
  assert.throws(() => pngFilterRows(pixels, 0, 2), /尺寸/);
  assert.throws(() => pngFilterRows(pixels, 2, 1.5), /尺寸/);
});

test('跨多个Canvas条带编码为同一PNG，解压后每一行保持准确顺序', async () => {
  const width = 2, height = 5;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    pixels.set([row * 30, 10, 20, 255, 5, row * 40, 80, row * 50], row * width * 4);
  }
  const calls: [number, number][] = [];
  const png = await encodePngBands(width, height, async (top, rows) => {
    calls.push([top, rows]);
    return pixels.slice(top * width * 4, (top + rows) * width * 4);
  }, 2);
  assert.equal(png.type, 'image/png'); assert.deepEqual(calls, [[0, 2], [2, 2], [4, 1]]);
  const chunks = readChunks(Buffer.from(await png.arrayBuffer()));
  assert.equal(chunks[0].data.readUInt32BE(0), width); assert.equal(chunks[0].data.readUInt32BE(4), height);
  assert.ok(chunks.some(chunk => chunk.type === 'IDAT'));
  assert.ok(chunks.slice(1, -1).every(chunk => chunk.type === 'IDAT'), 'one image must contain one contiguous IDAT stream');
  assert.equal(chunks.at(-1)!.data.length, 0);
  const rows = inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)));
  assert.equal(rows.length, height * (width * 4 + 1));
  for (let row = 0; row < height; row++) {
    const offset = row * (width * 4 + 1); assert.equal(rows[offset], 0, `row ${row} filter`);
    assert.deepEqual(rows.subarray(offset + 1, offset + 1 + width * 4), Buffer.from(pixels.subarray(row * width * 4, (row + 1) * width * 4)), `row ${row} RGBA`);
  }
});

test('条带读取失败或像素尺寸不符时拒绝整张图片，不返回截断的半张PNG', async () => {
  const failed = new Error('simulated canvas band read failure');
  await assert.rejects(encodePngBands(1, 3, top => {
    if (top > 0) throw failed;
    return new Uint8ClampedArray([255, 255, 255, 255]);
  }, 1), error => error === failed);
  await assert.rejects(encodePngBands(1, 3, () => new Uint8ClampedArray(3), 1), /尺寸/);
  let touched = false;
  await assert.rejects(encodePngBands(1, 3, () => { touched = true; return new Uint8ClampedArray(); }, 0), /分带高度/);
  assert.equal(touched, false);
});

test('超过32767像素的真实PNG仍保留跨界行和最终一行，不只修改图片头', async () => {
  const width = 1, height = 33001;
  const png = await encodePngBands(width, height, (top, count) => {
    const pixels = new Uint8ClampedArray(count * 4);
    for (let row = 0; row < count; row++) {
      const absolute = top + row; pixels.set([absolute & 255, absolute >>> 8 & 255, 47, 255], row * 4);
    }
    return pixels;
  });
  const chunks = readChunks(Buffer.from(await png.arrayBuffer()));
  assert.equal(chunks[0].data.readUInt32BE(4), height);
  const rows = inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)));
  assert.equal(rows.length, height * 5);
  for (const row of [0, 511, 512, 32766, 32767, 32768, height - 1]) {
    assert.deepEqual([...rows.subarray(row * 5, row * 5 + 5)], [0, row & 255, row >>> 8 & 255, 47, 255], `row ${row} is preserved in the single PNG`);
  }
});
