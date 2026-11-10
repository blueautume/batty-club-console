import type { Customer, PricedItem, QuoteItemInput, QuoteResult, Settings } from './types.ts';

export const defaultSettings: Settings = {
  clubName: '贝蒂电竞俱乐部',
  prices: { '机密': { '娱乐陪': 6000, '技术陪': 12000, '高阶陪': 13000, '明星陪': 16000, '本月置顶明星': 20000 }, '绝密': { '娱乐陪': 8000, '技术陪': 14000, '高阶陪': 18000, '明星陪': 23000, '本月置顶明星': 28000 } },
  pairDiscounts: { '娱乐陪': 0, '技术陪': 1000, '高阶陪': 1500, '明星陪': 2000, '本月置顶明星': 3000 },
  femaleHourlyCents: 1000, extraCustomerHourlyCents: 2000, sixHourRate: 0.98,
  members: {
    '普通客户': { initialCents: 0, renewalCents: 0, rate: 1, wechatLimit: 0 },
    '白银': { initialCents: 300000, renewalCents: 100000, rate: 0.95, wechatLimit: 1 },
    '黄金': { initialCents: 666600, renewalCents: 200000, rate: 0.93, wechatLimit: 2 },
    '铂金': { initialCents: 999900, renewalCents: 500000, rate: 0.92, wechatLimit: 0 },
    '钻石': { initialCents: 5000000, renewalCents: 2000000, rate: 0.9, wechatLimit: 0 },
    '红卡': { initialCents: 10000000, renewalCents: 5000000, rate: 0.85, wechatLimit: 0 }
  }
};

function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const cents = (n: number) => Math.round(n + Number.EPSILON);

export function priceQuote(inputs: QuoteItemInput[], customer: Pick<Customer, 'member' | 'benefit'>, settings: Settings = defaultSettings): QuoteResult {
  assert(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 30, '请添加1至30条服务明细');
  const warnings: string[] = [];
  const ids = new Set<string>();
  const items: PricedItem[] = inputs.map(input => {
    assert(input && typeof input.id === 'string' && input.id.length > 0 && !ids.has(input.id), '服务明细编号重复或缺失'); ids.add(input.id);
    assert(typeof input.hours === 'number' && Number.isFinite(input.hours) && input.hours > 0 && input.hours <= 168, '服务时长须大于0且不超过168小时');
    assert(input.customerCount === 1 || input.customerCount === 2, '每项服务支持1位或2位客人');
    assert(['member', 'sixHour', 'none'].includes(input.discount), '折扣选项无效');
    assert(input.kind === 'normal' || input.kind === 'trial', '服务类型无效');
    const hourly = settings.prices[input.mode]?.[input.tier];
    assert(Number.isSafeInteger(hourly) && hourly > 0, '模式或档位不在价目表中');
    if (input.plannedStart) assert(Number.isFinite(Date.parse(input.plannedStart)), '预约时间格式无效');
    if (input.kind === 'trial') {
      assert(input.tier === '技术陪', '99元体验仅适用于技术陪，其他档位请按正常服务报价');
      assert(!input.groupId && input.discount === 'none', '99元体验单不参与双陪组合及其他折扣');
      assert(typeof input.promise === 'string' && input.promise.trim().length > 0, '体验单请写明模式、安排及保障内容');
      return { ...input, baseHourlyCents: 0, surchargeHourlyCents: 0, baseCents: 9900, groupDiscountCents: 0, discountRate: 1, discountCents: 0, totalCents: 9900 };
    }
    const surcharge = (input.female ? settings.femaleHourlyCents : 0) + (input.customerCount === 2 && input.tier !== '娱乐陪' ? settings.extraCustomerHourlyCents : 0);
    return { ...input, baseHourlyCents: hourly, surchargeHourlyCents: surcharge, baseCents: cents((hourly + surcharge) * input.hours), groupDiscountCents: 0, discountRate: 1, discountCents: 0, totalCents: 0 };
  });
  const groups = new Map<string, PricedItem[]>();
  items.filter(i => i.groupId).forEach(i => groups.set(i.groupId, [...(groups.get(i.groupId) || []), i]));
  for (const group of groups.values()) {
    assert(group.length === 2, '每个双陪组合须恰好有两条单人报价');
    assert(group.every(i => i.kind === 'normal' && i.customerCount === 1), '双陪组合仅支持两位陪玩服务同一位客人');
    assert(group[0].mode === group[1].mode, '双陪组合须为同一模式，不同模式请分为独立服务');
    let hourlyDiscount: number;
    if (group[0].tier === group[1].tier) hourlyDiscount = settings.pairDiscounts[group[0].tier] || 0;
    else {
      const entered = group.map(i => i.groupDiscountHourlyCents).filter(v => v !== undefined);
      assert(entered.length > 0 && entered.every(v => v === entered[0]), '混档双陪请填写一致的整组每小时减免金额');
      hourlyDiscount = entered[0]!;
      warnings.push('混档双陪减免由客服人工确认，已按整组计入一次。');
    }
    assert(Number.isSafeInteger(hourlyDiscount) && hourlyDiscount >= 0, '整组减免须为不小于0的整数分');
    let hours = Math.min(...group.map(i => i.hours));
    if (group.every(i => i.plannedStart)) {
      const starts = group.map(i => Date.parse(i.plannedStart));
      const ends = group.map((i, n) => starts[n] + i.hours * 3600000);
      hours = Math.max(0, (Math.min(...ends) - Math.max(...starts)) / 3600000);
    }
    const base = group.reduce((a, i) => a + i.baseCents, 0);
    const deduction = cents(hourlyDiscount * hours);
    assert(deduction <= base, '双陪减免不能超过该组服务金额');
    group[0].groupDiscountCents = cents(deduction * group[0].baseCents / base);
    group[1].groupDiscountCents = deduction - group[0].groupDiscountCents;
    if (group[0].hours !== group[1].hours) warnings.push('双陪时长不同，整组减免仅计算共同服务时长。');
  }
  const memberRate = customer.benefit === 'discount' ? (settings.members[customer.member]?.rate ?? 1) : 1;
  for (const item of items) {
    if (item.kind === 'trial') continue;
    assert(item.discount !== 'sixHour' || item.hours >= 6, '6小时98折按每条报价时长判断，不合并陪玩人数或其他明细时长');
    item.discountRate = item.discount === 'member' ? memberRate : item.discount === 'sixHour' ? settings.sixHourRate : 1;
    assert(item.discountRate > 0 && item.discountRate <= 1, '折扣配置无效');
    const beforeRate = item.baseCents - item.groupDiscountCents;
    item.totalCents = cents(beforeRate * item.discountRate);
    item.discountCents = beforeRate - item.totalCents;
    const candidates = [{ rate: memberRate, label: '会员折扣' }, ...(item.hours >= 6 ? [{ rate: settings.sixHourRate, label: '6小时包时折扣' }] : [])];
    const best = candidates.sort((a,b) => a.rate - b.rate)[0];
    const saving = item.totalCents - cents(beforeRate * best.rate);
    if (saving > 0) item.betterDiscount = `${best.label}更优惠，可再省¥${(saving / 100).toFixed(2)}，请客服手动选择`;
  }
  return { items, subtotalCents: items.reduce((a,i) => a+i.baseCents,0), groupDiscountCents: items.reduce((a,i) => a+i.groupDiscountCents,0), discountCents: items.reduce((a,i) => a+i.discountCents,0), totalCents: items.reduce((a,i) => a+i.totalCents,0), warnings: [...new Set(warnings)] };
}
