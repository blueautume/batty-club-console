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

/** Measured once and drawn once, with no dependency on screen size or drawer state. */
export function layoutConfirmationImage(doc: ConfirmationDocument, measure: (text: string, font: string) => number): ConfirmationLayout {
  const commands: ConfirmationDrawCommand[] = [];
  const pageWidth = CONFIRMATION_LOGICAL_WIDTH, edge = 28, contentWidth = pageWidth - edge * 2;
  let y = 0;
  const font = (size: number, weight = 400) => `${weight} ${size}px ${fontFamily}`;
  const text = (value: string, x: number, width: number, size = 22, color = ink, weight = 400, lineHeight = Math.ceil(size * 1.55)) => {
    const style = font(size, weight);
    const lines = wrapConfirmationText(value, width, line => measure(line, style));
    for (const line of lines) { commands.push({ type: 'text', text: line, x, y, font: style, color }); y += lineHeight; }
  };
  const box = (x: number, width: number, fill = '#ffffff', stroke?: string, radius = 16) => {
    const command: BoxCommand = { type: 'box', x, y, width, height: 0, radius, fill, stroke }; commands.push(command); return command;
  };
  const line = (x: number, width: number, dashed = false) => { commands.push({ type: 'line', x, y, width, color: border, dashed }); };
  const field = (label: string, value: string, x = edge + 24, width = contentWidth - 48) => {
    text(label, x, width, 17, muted, 500, 27);
    text(value, x, width, 21, ink, 400, 32);
  };

  commands.push({ type: 'box', x: 0, y: 0, width: pageWidth, height: 10, radius: 0, fill: purple });
  y = 38;
  text('BATTY CLUB', edge, contentWidth, 14, purple, 700, 23);
  text(doc.clubName, edge, contentWidth, 25, ink, 650, 37);
  y += 12;
  text(doc.kind === 'supplement' ? '补款确认单' : '客户确认单', edge, contentWidth, 34, ink, 700, 48);
  text(`第 ${doc.quoteVersion} 版报价 · ${doc.statusLabel}`, edge, contentWidth, 18, muted, 400, 29);
  y += 22;

  const identity = box(edge, contentWidth, pale);
  y += 22;
  field('客户', `${doc.customerName} · ${doc.memberLabel}`);
  y += 14;
  field('订单编号', doc.orderCode);
  if (doc.kind === 'supplement') { y += 14; field('关联原订单', doc.parentOrderCode); }
  y += 22; identity.height = y - identity.y;
  y += 24;

  if (doc.statusNotice) {
    const notice = box(edge, contentWidth, '#fff8eb', '#f3e5c8');
    y += 18; text(doc.statusNotice, edge + 20, contentWidth - 40, 19, '#94692e', 500, 30); y += 18; notice.height = y - notice.y; y += 24;
  }

  text(doc.kind === 'supplement' ? '本次补款约定' : `服务与报价明细 · ${doc.items.length} 项`, edge, contentWidth, 22, ink, 650, 34);
  y += 14;
  if (doc.kind === 'supplement') {
    const supplement = box(edge, contentWidth, '#ffffff', border);
    y += 24; text(doc.supplementReason || '按客服确认的补款约定执行', edge + 24, contentWidth - 48, 22, ink, 500, 35);
    y += 14; text('仅补充约定费用，不新增服务时长。', edge + 24, contentWidth - 48, 19, muted, 400, 30);
    y += 24; supplement.height = y - supplement.y; y += 20;
  }

  for (const item of doc.items) {
    const card = box(edge, contentWidth, '#ffffff', border);
    const x = edge + 24, width = contentWidth - 48;
    y += 24;
    text(`${item.index}  ${item.title}`, x, width, 25, ink, 650, 37);
    text(item.amount, x, width, 30, purple, 700, 45);
    y += 8;
    for (const meta of item.meta) text(meta, x, width, 19, muted, 400, 29);
    y += 18;

    const calculation = box(x - 4, width + 8, '#faf9ff', undefined, 10);
    y += 17;
    const mathX = x + 12, mathWidth = width - 24;
    text('费用计算明细', mathX, mathWidth, 19, purple, 650, 31);
    y += 7;
    for (const step of item.steps) { text(step, mathX, mathWidth, 20, '#575368', 400, 31); y += 10; }
    line(mathX, mathWidth, true); y += 15;
    text('本项计算式', mathX, mathWidth, 17, muted, 500, 27);
    text(item.formula, mathX, mathWidth, 21, purple, 650, 33);
    y += 10;
    y += 12; calculation.height = y - calculation.y;
    y += 20;

    field('预约时间', item.appointment, x, width); y += 12;
    field('陪玩人选', item.player, x, width);
    if (item.promise) { y += 16; field('服务承诺', item.promise, x, width); }
    y += 24; card.height = y - card.y; y += 20;
  }

  for (const group of doc.groups) {
    const groupBox = box(edge, contentWidth, pale);
    y += 20; text(group.title, edge + 22, contentWidth - 44, 21, purple, 650, 33); y += 9;
    text(group.formula, edge + 22, contentWidth - 44, 19, ink, 400, 30); y += 10;
    text(group.allocation, edge + 22, contentWidth - 44, 17, muted, 400, 27);
    for (const note of group.notes) { y += 10; text(note, edge + 22, contentWidth - 44, 17, muted, 400, 27); }
    y += 20; groupBox.height = y - groupBox.y; y += 20;
  }

  y += 5;
  const summary = box(edge, contentWidth, '#ffffff', border);
  const sumX = edge + 24, sumWidth = contentWidth - 48;
  y += 24;
  text('费用合计', sumX, sumWidth, 24, ink, 650, 38); y += 10;
  for (const row of doc.summaryRows) {
    const rowY = y, valueStyle = font(21, 600), valueWidth = Math.min(measure(row.value, valueStyle), sumWidth * 0.62);
    const labelWidth = sumWidth - valueWidth - 12;
    text(row.label, sumX, labelWidth, 20, muted, 400, 31);
    const labelEnd = y; y = rowY;
    text(row.value, sumX + sumWidth - valueWidth, valueWidth + 1, 21, ink, 600, 31);
    y = Math.max(y, labelEnd) + 11;
  }
  y += 4; line(sumX, sumWidth, true); y += 18;
  text('合计计算式', sumX, sumWidth, 17, muted, 500, 28);
  text(doc.totalFormula, sumX, sumWidth, 21, purple, 650, 34);
  if (doc.adjustmentReason) { y += 14; field('整单调整说明', doc.adjustmentReason, sumX, sumWidth); }
  y += 18; line(sumX, sumWidth); y += 22;
  text(doc.totalLabel, sumX, sumWidth, 20, ink, 500, 32);
  text(doc.total, sumX, sumWidth, 42, purple, 750, 58);
  y += 24; summary.height = y - summary.y;
  y += 22;

  if (doc.promise) {
    const promise = box(edge, contentWidth, pale);
    y += 22; text('本单服务约定', edge + 24, contentWidth - 48, 21, purple, 650, 33); y += 8;
    text(doc.promise, edge + 24, contentWidth - 48, 21, ink, 400, 34);
    y += 22; promise.height = y - promise.y; y += 24;
  }
  if (doc.calculationNotes.length) {
    text('计价说明', edge + 4, contentWidth - 8, 18, muted, 500, 29);
    for (const note of doc.calculationNotes) { text(note, edge + 4, contentWidth - 8, 17, '#858093', 400, 27); y += 8; }
    y += 14;
  }
  text(doc.footer, edge + 4, contentWidth - 8, 19, muted, 400, 31);
  y += 20;
  text('报价以本单保存的版本为准', edge + 4, contentWidth - 8, 16, '#9993a8', 400, 25);
  y += 32;
  if (y * CONFIRMATION_IMAGE_SCALE > CONFIRMATION_MAX_IMAGE_HEIGHT || pageWidth * y * CONFIRMATION_IMAGE_SCALE ** 2 > CONFIRMATION_MAX_PIXELS) throw new Error('确认单内容过长，超出单张长图的安全尺寸；请精简重复的服务承诺或拆分订单后重试，系统不会截断明细。');
  return { width: pageWidth, height: Math.ceil(y), commands };
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
  const useBands = height > 16000;
  canvas.width = width; canvas.height = useBands ? Math.min(512, height) : height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成确认单图片，请更换浏览器重试');
  const brush = context;
  function draw(top = 0) {
    brush.setTransform(1, 0, 0, 1, 0, 0);
    brush.fillStyle = '#f4f2f9'; brush.fillRect(0, 0, canvas.width, canvas.height);
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
