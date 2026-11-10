import type { PricedItem } from './types.ts';

export interface ItemPriceExplanation {
  steps: string[];
  formula: string;
  notes: string[];
  discountLabel: string;
}

/** Display only: prices and reductions come from the saved quote, never today's settings. */
export function priceMoney(value: number): string {
  return `${value < 0 ? '−' : ''}¥${(Math.abs(value) / 100).toFixed(2)}`;
}

function decimal(value: number): string {
  return String(Number(value.toFixed(8)));
}

export function priceDiscountLabel(item: Pick<PricedItem, 'kind' | 'discount' | 'discountRate'>): string {
  if (item.kind === 'trial') return '固定活动价';
  if (item.discount === 'none') return '不使用比例折扣';
  if (item.discountRate === 1) return item.discount === 'member' ? '会员权益未提供比例折扣' : '比例折扣为原价';
  return `${item.discount === 'sixHour' ? '6小时包时' : '会员'} ${decimal(item.discountRate * 10)}折`;
}

export function itemPriceExplanation(item: PricedItem): ItemPriceExplanation {
  if (item.kind === 'trial') {
    return {
      steps: [`新客体验固定活动价：${priceMoney(item.baseCents)}，按本次约定的模式、人员、时长和保障内容执行。`],
      formula: `活动固定价 ${priceMoney(item.baseCents)} = ${priceMoney(item.totalCents)}`,
      notes: ['固定活动价不按小时再次相乘，不叠加比例折扣和双陪优惠。'],
      discountLabel: '固定活动价'
    };
  }

  const surchargeKinds = [item.female ? '指定女陪' : '', item.customerCount === 2 && item.tier !== '娱乐陪' ? '一陪二' : ''].filter(Boolean);
  const surchargeLabel = surchargeKinds.length ? `${surchargeKinds.join('、')}附加合计` : '附加费合计';
  const hourly = item.baseHourlyCents + item.surchargeHourlyCents;
  const steps = [
    item.surchargeHourlyCents
      ? `计费单价：基础 ${priceMoney(item.baseHourlyCents)} + ${surchargeLabel} ${priceMoney(item.surchargeHourlyCents)} = ${priceMoney(hourly)}/位/小时`
      : `计费单价：基础 ${priceMoney(item.baseHourlyCents)}/位/小时，无收费附加项`,
    `基础及附加费：${priceMoney(hourly)}/位/小时 × 1位陪玩 × ${decimal(item.hours)}小时 = ${priceMoney(item.baseCents)}`
  ];
  const beforeRate = item.baseCents - item.groupDiscountCents;
  if (item.groupDiscountCents) steps.push(`双陪整组优惠的本项分摊：${priceMoney(item.baseCents)} − ${priceMoney(item.groupDiscountCents)} = ${priceMoney(beforeRate)}`);
  const label = priceDiscountLabel(item);
  steps.push(item.discountRate < 1
    ? `${label}：${priceMoney(beforeRate)} × ${decimal(item.discountRate)} = ${priceMoney(item.totalCents)}，本项比例优惠 ${priceMoney(item.discountCents)}`
    : `${label}：折扣系数 × 1，本项应付 ${priceMoney(item.totalCents)}`);

  const formula = `${item.groupDiscountCents ? `(${priceMoney(item.baseCents)} − ${priceMoney(item.groupDiscountCents)})` : priceMoney(item.baseCents)} × ${decimal(item.discountRate)} = ${priceMoney(item.totalCents)}`;
  const notes = ['金额在基础费用与比例折扣两个计算阶段分别四舍五入到分。'];
  if (item.groupId) notes.push(item.groupDiscountCents
    ? '整组优惠仅计一次，按两项基础及附加费占比分摊；分摊尾差保留在组内最后一项。此处已经扣除本项分摊额。'
    : '此双陪组合本项分摊优惠为零；是否享受整组优惠以报价中保存的减免金额为准。');
  if (item.surchargeHourlyCents && surchargeKinds.length > 1) notes.push('本报价保存的是附加费合计，按此报价金额核对。');
  return { steps, formula, notes, discountLabel: label };
}

/** Items are already net of group and proportional discounts: do not subtract them again. */
export function quotePriceFormula(items: Pick<PricedItem, 'totalCents'>[], totalCents: number, adjustmentCents = 0): string {
  const service = items.length ? items.map(item => priceMoney(item.totalCents)).join(' + ') : priceMoney(0);
  const adjustment = adjustmentCents ? ` ${adjustmentCents > 0 ? '+' : '−'} ${priceMoney(Math.abs(adjustmentCents))}` : '';
  return `${service}${adjustment} = ${priceMoney(totalCents)}`;
}

export interface GroupPriceExplanation {
  groupId: string;
  totalReductionCents: number;
  formula: string;
  allocation: string;
}

export function groupPriceExplanations(items: PricedItem[]): GroupPriceExplanation[] {
  const groups = new Map<string, PricedItem[]>();
  for (const item of items) if (item.groupId) groups.set(item.groupId, [...(groups.get(item.groupId) || []), item]);
  return [...groups].map(([groupId, members]) => {
    const totalReductionCents = members.reduce((sum, item) => sum + item.groupDiscountCents, 0);
    const totalBase = members.reduce((sum, item) => sum + item.baseCents, 0);
    return {
      groupId, totalReductionCents,
      formula: `整组减免 ${priceMoney(totalReductionCents)} = ${members.map(item => priceMoney(item.groupDiscountCents)).join(' + ')}（各项分摊，整组只减一次）`,
      allocation: members.map((item, index) => `第${index + 1}项：${priceMoney(totalReductionCents)} × ${priceMoney(item.baseCents)} ÷ ${priceMoney(totalBase)} → ${priceMoney(item.groupDiscountCents)}${index === members.length - 1 ? '（含尾差）' : '（四舍五入到分）'}`).join('；')
    };
  });
}
