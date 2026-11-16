import {
  CONFIRMATION_IMAGE_SCALE, CONFIRMATION_IMAGE_WIDTH, CONFIRMATION_LOGICAL_WIDTH,
  CONFIRMATION_MAX_IMAGE_HEIGHT, CONFIRMATION_MAX_PIXELS, wrapConfirmationText
} from '../../shared/confirmation.ts';
import type { ConfirmationDocument } from '../../shared/confirmation.ts';
import { encodePngBands } from './pngEncoder.ts';

const fontFamily = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const ink = '#262438', muted = '#77758a', purple = '#6250dc', pale = '#f6f4ff', border = '#e9e5f4';
type TextCommand = { type: 'text'; text: string; x: number; y: number; font: string; color: string };
type BoxCommand = { type: 'box'; x: number; y: number; width: number; height: number; radius: number; fill: string; stroke?: string };
type LineCommand = { type: 'line'; x: number; y: number; width: number; color: string; dashed?: boolean };
export type ConfirmationDrawCommand = TextCommand | BoxCommand | LineCommand;
export interface ConfirmationLayout { width: number; height: number; commands: ConfirmationDrawCommand[]; }
export interface ConfirmationImage { blob: Blob; width: number; height: number; }

/** Export a compact desktop-style quotation, independently of the current page width. */
export function layoutConfirmationImage(doc: ConfirmationDocument, measure: (text: string, font: string) => number): ConfirmationLayout {
  const commands: ConfirmationDrawCommand[] = [];
  const pageWidth = CONFIRMATION_LOGICAL_WIDTH, edge = 24, contentWidth = pageWidth - edge * 2;
  let y = 26;
  const font = (size: number, weight = 400) => `${weight} ${size}px ${fontFamily}`;
  const text = (value: string, x: number, width: number, size = 15, color = ink, weight = 400, lineHeight = Math.ceil(size * 1.65)) => {
    const style = font(size, weight);
    for (const valueLine of wrapConfirmationText(value, width, line => measure(line, style))) {
      commands.push({ type: 'text', text: valueLine, x, y, font: style, color }); y += lineHeight;
    }
  };
  const box = (x: number, width: number, fill = '#ffffff', stroke?: string, radius = 10) => {
    const command: BoxCommand = { type: 'box', x, y, width, height: 0, radius, fill, stroke }; commands.push(command); return command;
  };
  const line = (x: number, width: number) => { commands.push({ type: 'line', x, y, width, color: border }); };
  const columns = (left: string, right: string, x: number, width: number, leftSize: number, rightSize: number, rightColor = ink, rightWeight = 600) => {
    const measuredValueWidth = measure(right, font(rightSize, rightWeight));
    const valueWidth = Math.max(130, Math.min(measuredValueWidth, width * 0.42));
    const top = y;
    text(left, x, width - valueWidth - 22, leftSize, muted, 400);
    const leftEnd = y; y = top;
    const drawWidth = Math.min(valueWidth, measuredValueWidth);
    text(right, x + width - drawWidth, drawWidth + 1, rightSize, rightColor, rightWeight);
    y = Math.max(y, leftEnd);
  };

  const titleY = y;
  text(doc.clubName, edge, contentWidth * 0.62, 22, ink, 650, 32);
  const clubEnd = y; y = titleY;
  const heading = doc.kind === 'supplement' ? '补款确认单' : '客户确认单';
  const headingWidth = measure(heading, font(21, 650));
  text(heading, pageWidth - edge - headingWidth, headingWidth + 1, 21, purple, 650, 32);
  y = Math.max(y, clubEnd) + 10;
  text(`客户：${doc.customerName} · ${doc.memberLabel}    订单：${doc.orderCode}    第 ${doc.quoteVersion} 版报价 · ${doc.statusLabel}`, edge, contentWidth, 14, muted, 400, 24);
  y += 12; line(edge, contentWidth); y += 20;

  if (doc.statusNotice) {
    const notice = box(edge, contentWidth, '#fff8eb', '#f3e5c8', 8);
    y += 12; text(doc.statusNotice, edge + 16, contentWidth - 32, 14, '#94692e', 500, 23);
    y += 12; notice.height = y - notice.y; y += 18;
  }

  if (doc.kind === 'supplement') {
    const supplement = box(edge, contentWidth, '#ffffff', border);
    y += 18;
    columns('关联补款单', doc.total, edge + 20, contentWidth - 40, 18, 26, purple, 700);
    y += 10; text(`关联原订单：${doc.parentOrderCode}`, edge + 20, contentWidth - 40, 14, muted, 400, 23);
    text(doc.supplementReason || '按客服确认的补款约定执行', edge + 20, contentWidth - 40, 15, ink, 400, 25);
    text('仅补充约定费用，不新增服务时长。', edge + 20, contentWidth - 40, 13, muted, 400, 22);
    y += 18; supplement.height = y - supplement.y; y += 18;
  }

  for (const item of doc.items) {
    const card = box(edge, contentWidth, '#ffffff', border);
    const x = edge + 20, width = contentWidth - 40;
    y += 20;
    const titleTop = y;
    const indexBox = box(x, 28, '#efecfb', undefined, 4); indexBox.height = 28;
    y += 5;
    text(item.index, x + 6, 24, 12, '#a396c8', 650, 18);
    y = titleTop;
    const measuredAmountWidth = measure(item.amount, font(26, 700));
    const amountWidth = Math.max(145, Math.min(measuredAmountWidth, width * 0.35));
    text(item.title, x + 42, width - amountWidth - 60, 19, '#48465e', 650, 31);
    const titleEnd = y; y = titleTop;
    const drawAmountWidth = Math.min(amountWidth, measuredAmountWidth);
    text(item.amount, x + width - drawAmountWidth, drawAmountWidth + 1, 26, purple, 700, 34);
    y = Math.max(y, titleEnd) + 13;
    text(item.meta.join('    '), x, width, 14, '#8f8fa4', 400, 25);
    y += 12; line(x, width); y += 13;
    text(`预约：${item.appointment}    人选：${item.player}`, x, width, 13, '#8c8da4', 400, 23);
    if (item.promise) {
      y += 10;
      const promise = box(x, width, '#faf9fd', undefined, 6);
      y += 10; text(`服务承诺：${item.promise}`, x + 12, width - 24, 14, '#777b91', 400, 24);
      y += 10; promise.height = y - promise.y;
    }
    y += 18; card.height = y - card.y; y += 18;
  }

  const sumWidth = 420, sumX = pageWidth - edge - sumWidth;
  y += 2;
  for (const row of doc.summaryRows) {
    columns(row.label, row.value, sumX, sumWidth, 14, 16, '#616174', 550);
    y += 7;
  }
  if (doc.adjustmentReason) {
    y += 3; text(`调整说明：${doc.adjustmentReason}`, sumX, sumWidth, 13, muted, 400, 22); y += 8;
  }
  y += 5; line(sumX, sumWidth); y += 18;
  columns(doc.totalLabel, doc.total, sumX, sumWidth, 18, 31, purple, 700);
  y += 18;

  if (doc.promise) {
    const promise = box(edge, contentWidth, pale, undefined, 7);
    y += 12; text(`本单服务约定：${doc.promise}`, edge + 16, contentWidth - 32, 14, '#777b91', 400, 24);
    y += 12; promise.height = y - promise.y; y += 14;
  }
  text(doc.footer, edge, contentWidth, 13, '#9993a8', 400, 22);
  y += 20;
  const height = Math.ceil(y), outputHeight = height * CONFIRMATION_IMAGE_SCALE;
  if (outputHeight > CONFIRMATION_MAX_IMAGE_HEIGHT || CONFIRMATION_IMAGE_WIDTH * outputHeight > CONFIRMATION_MAX_PIXELS) throw new Error('确认单内容过长，超出单张图片的安全尺寸；请精简重复的服务承诺或拆分订单后重试，系统不会截断明细。');
  return { width: pageWidth, height, commands };
}

export async function renderConfirmationImage(doc: ConfirmationDocument): Promise<ConfirmationImage> {
  if (typeof document === 'undefined') throw new Error('请在浏览器中生成确认单图片');
  await document.fonts.ready;
  const measuring = document.createElement('canvas');
  const measureContext = measuring.getContext('2d');
  if (!measureContext) throw new Error('当前浏览器无法生成确认单图片，请更换浏览器重试');
  const layout = layoutConfirmationImage(doc, (value, style) => { measureContext.font = style; return measureContext.measureText(value).width; });
  const canvas = document.createElement('canvas');
  const width = CONFIRMATION_IMAGE_WIDTH, height = layout.height * CONFIRMATION_IMAGE_SCALE;
  const useBands = height > 16000 || width * height > 16_000_000;
  canvas.width = width; canvas.height = useBands ? Math.min(512, height) : height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成确认单图片，请更换浏览器重试');
  const brush = context;
  function draw(top = 0) {
    brush.setTransform(1, 0, 0, 1, 0, 0);
    brush.fillStyle = '#ffffff'; brush.fillRect(0, 0, canvas.width, canvas.height);
    brush.setTransform(CONFIRMATION_IMAGE_SCALE, 0, 0, CONFIRMATION_IMAGE_SCALE, 0, -top);
    brush.textBaseline = 'top';
    for (const command of layout.commands) {
    if (command.type === 'text') {
      brush.font = command.font; brush.fillStyle = command.color; brush.fillText(command.text, command.x, command.y);
    } else if (command.type === 'box') {
      brush.beginPath(); brush.roundRect(command.x, command.y, command.width, command.height, command.radius);
      brush.fillStyle = command.fill; brush.fill();
      if (command.stroke) { brush.strokeStyle = command.stroke; brush.lineWidth = 1; brush.stroke(); }
    } else {
      brush.beginPath(); brush.setLineDash(command.dashed ? [4, 4] : []); brush.moveTo(command.x, command.y); brush.lineTo(command.x + command.width, command.y);
      brush.strokeStyle = command.color; brush.lineWidth = 1; brush.stroke(); brush.setLineDash([]);
    }
    }
  }
  try {
    let blob: Blob;
    if (useBands) blob = await encodePngBands(width, height, (top, rows) => {
      canvas.height = rows; draw(top); return context.getImageData(0, 0, width, rows).data;
    });
    else { draw(); blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('浏览器未能生成长图，请精简内容或更换浏览器重试')), 'image/png')); }
    return { blob, width, height };
  } finally { canvas.width = 0; canvas.height = 0; measuring.width = 0; measuring.height = 0; }
}
