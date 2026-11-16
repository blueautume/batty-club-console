import type { Order } from './types.ts';
import { priceDiscountLabel, priceMoney } from './priceExplanation.ts';

export const CONFIRMATION_LOGICAL_WIDTH = 1100;
export const CONFIRMATION_IMAGE_SCALE = 2;
export const CONFIRMATION_IMAGE_WIDTH = CONFIRMATION_LOGICAL_WIDTH * CONFIRMATION_IMAGE_SCALE;
export const CONFIRMATION_MAX_IMAGE_HEIGHT = 59000;
export const CONFIRMATION_MAX_PIXELS = 64_000_000;

export interface ConfirmationContext {
  clubName?: string;
  playerNames?: Record<string, string>;
  parentOrderCode?: string;
}
export interface ConfirmationService {
  index: string;
  title: string;
  amount: string;
  meta: string[];
  appointment: string;
  player: string;
  promise: string;
}
export interface ConfirmationDocument {
  clubName: string;
  orderCode: string;
  quoteVersion: number;
  customerName: string;
  memberLabel: string;
  statusLabel: string;
  statusNotice: string;
  kind: 'normal' | 'supplement';
  parentOrderCode: string;
  supplementReason: string;
  adjustmentReason: string;
  items: ConfirmationService[];
  summaryRows: { label: string; value: string }[];
  total: string;
  totalLabel: string;
  promise: string;
  footer: string;
}

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date) : '待客服协调';
};

/** Explicit customer-facing projection: never copy an entire order into the image model. */
export function buildConfirmationDocument(order: Order, context: ConfirmationContext = {}): ConfirmationDocument {
  const refunded = order.refunds.reduce((sum, refund) => sum + refund.walletCents + refund.externalCents, 0);
  const cancelled = order.status === 'cancelled';
  const paid = !!order.payment;
  const statusLabel = cancelled ? '已取消' : refunded > 0 ? (refunded >= order.totalCents ? '已全额退款' : '部分退款') : paid ? '已结清' : order.status === 'confirmed' ? '客户已确认 · 待结清' : '待客户确认';
  const statusNotice = cancelled ? '此订单已取消，以下为原报价记录，不作为新的付款通知。'
    : refunded > 0 ? `本单已登记退款 ${priceMoney(refunded)}，以下保留原报价明细，不代表待付款金额。`
    : paid ? '此订单已结清，以下为已确认的报价记录，请勿重复付款。' : '';
  const supplement = order.kind === 'supplement';
  const summaryRows = [
    { label: '基础与附加费用', value: priceMoney(order.subtotalCents) },
    ...(order.groupDiscountCents ? [{ label: '双陪整组优惠', value: `−${priceMoney(order.groupDiscountCents)}` }] : []),
    ...(order.discountCents ? [{ label: '比例折扣优惠', value: `−${priceMoney(order.discountCents)}` }] : []),
    ...(order.adjustmentCents ? [{ label: supplement ? '约定补款' : '整单约定调整', value: `${order.adjustmentCents > 0 ? '+' : '−'}${priceMoney(Math.abs(order.adjustmentCents))}` }] : [])
  ];
  return {
    clubName: context.clubName?.trim() || '贝蒂电竞俱乐部', orderCode: order.code, quoteVersion: order.quoteVersion,
    customerName: order.customerName, memberLabel: order.member === '普通客户' ? '普通客户' : `${order.member}会员`,
    statusLabel, statusNotice, kind: supplement ? 'supplement' : 'normal',
    parentOrderCode: supplement ? context.parentOrderCode || order.parentOrderId || '待客服核对' : '',
    supplementReason: supplement ? order.adjustmentReason : '',
    adjustmentReason: !supplement && order.adjustmentCents ? order.adjustmentReason : '',
    items: order.items.map((item, index) => {
      const assignment = order.assignments.find(current => current.itemId === item.id && !['replaced', 'cancelled'].includes(current.status));
      const requested = context.playerNames?.[item.requestedPlayerId];
      return {
        index: String(index + 1).padStart(2, '0'), title: `${item.mode} · ${item.tier}${item.kind === 'trial' ? ' · 新客体验' : ''}`,
        amount: priceMoney(item.totalCents),
        meta: [`陪玩 1 位 · 客户 ${item.customerCount} 位`, `购买 ${item.hours} 小时`, priceDiscountLabel(item), ...(item.female ? ['指定女陪'] : []), ...(item.groupId ? ['双陪组合'] : [])],
        appointment: item.plannedStart ? formatDate(item.plannedStart) : '待客服协调',
        player: assignment?.playerName || (requested ? `指定 ${requested}` : '按档位安排'), promise: item.promise
      };
    }),
    summaryRows,
    total: priceMoney(order.totalCents), totalLabel: cancelled || refunded > 0 ? '原报价合计' : paid ? '本单报价合计' : supplement ? '本单补款合计' : '本单应付合计',
    promise: order.promise,
    footer: cancelled || refunded > 0 || paid ? '报价记录留存 · 售后及续时安排请联系服务客服。' : '请确认以上服务安排与总价。延长服务时，另行确认续单费用。'
  };
}

const prohibitedLineStart = new Set(Array.from('。，、：；！？）》」』】〕〉］｝〗〙〛”’…,.!?;:%％)]}'));
const prohibitedLineEnd = new Set(Array.from('（《「『【〔〈［｛〖〘〚“‘([{'));
const isSpace = (value: string | undefined) => !!value && /^\s+$/u.test(value);

/**
 * Grapheme-safe wrapping with Chinese line-breaking rules; manual newlines stay intact.
 * At exceptionally narrow widths, a prohibited punctuation boundary may be unavoidable.
 * Character preservation and fitting a line take priority; a single oversized grapheme
 * remains intact on its own line rather than splitting a combined emoji or accent.
 * Monetary values and numeric factors stay atomic when they fit within a full line;
 * an inherently oversized numeric token falls back to the same grapheme-safe rules.
 */
export function wrapConfirmationText(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  if (!(maxWidth > 0) || !Number.isFinite(maxWidth)) throw new Error('确认单文本排版宽度无效');
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
  const lines: string[] = [];
  for (const paragraph of text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    const graphemes = [...segmenter.segment(paragraph)];
    const boundaries = new Set([...graphemes.map(value => value.index), paragraph.length]);
    const numbers = new Map<number, string>();
    const numberPattern = /(?:[+−-][ \t]*)?(?:[¥￥][ \t]*(?:[+−-][ \t]*)?)?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)[%％]?/gu;
    for (const match of paragraph.matchAll(numberPattern)) {
      if (boundaries.has(match.index) && boundaries.has(match.index + match[0].length) && measure(match[0]) <= maxWidth) numbers.set(match.index, match[0]);
    }
    const characters: string[] = [];
    for (let index = 0; index < graphemes.length;) {
      const current = graphemes[index]!, number = numbers.get(current.index);
      if (number) {
        characters.push(number);
        const end = current.index + number.length;
        while (index < graphemes.length && graphemes[index]!.index < end) index++;
      } else { characters.push(current.segment); index++; }
    }
    if (!characters.length) { lines.push(''); continue; }
    let start = 0;
    while (start < characters.length) {
      let end = start + 1, candidate = characters[start]!;
      while (end < characters.length && measure(candidate + characters[end]) <= maxWidth) { candidate += characters[end]; end++; }
      let boundary = end;
      if (end < characters.length) {
        // Carry one preceding base grapheme with a closing punctuation run.
        let next = end;
        while (isSpace(characters[next])) next++;
        if (prohibitedLineStart.has(characters[next]!)) {
          let carried = end - 1;
          while (carried >= start && (prohibitedLineStart.has(characters[carried]!) || isSpace(characters[carried]))) carried--;
          boundary = Math.max(start, carried);
        }
        // Carry opening brackets/quotes, including adjacent spaces, to the next line.
        while (boundary > start) {
          let previous = boundary - 1;
          while (previous >= start && isSpace(characters[previous])) previous--;
          if (previous < start || !prohibitedLineEnd.has(characters[previous]!)) break;
          boundary = previous;
        }
      }
      // Moving a whole punctuation run may leave no legal non-empty line at this width.
      if (boundary <= start) boundary = end;
      lines.push(characters.slice(start, boundary).join(''));
      start = boundary;
    }
  }
  return lines;
}
