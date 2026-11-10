import test from 'node:test';
import assert from 'node:assert/strict';
import { priceQuote, defaultSettings } from '../shared/pricing.ts';
import { groupPriceExplanations, itemPriceExplanation, quotePriceFormula } from '../shared/priceExplanation.ts';
import type { QuoteItemInput } from '../shared/types.ts';

const customer = { member: '白银' as const, benefit: 'discount' as const };
const row = (patch: Partial<QuoteItemInput> = {}): QuoteItemInput => ({ id: 'a', mode: '机密', tier: '技术陪', hours: 2, female: false, customerCount: 1, discount: 'member', groupId: '', plannedStart: '', requestedPlayerId: '', promise: '', kind: 'normal', ...patch });

test('普通服务解释基础单价、时长、会员折扣和最终金额', () => {
  const item = priceQuote([row()], customer).items[0];
  const explanation = itemPriceExplanation(item);
  assert.match(explanation.steps.join('\n'), /¥120\.00\/位\/小时 × 1位陪玩 × 2小时 = ¥240\.00/);
  assert.match(explanation.steps.join('\n'), /会员 9\.5折/);
  assert.equal(explanation.formula, '¥240.00 × 0.95 = ¥228.00');
});

test('女陪及一陪二附加显示保存的合计，不凭当前配置猜分项', () => {
  const item = priceQuote([row({ female: true, customerCount: 2 })], customer).items[0];
  const explanation = itemPriceExplanation(item);
  assert.match(explanation.steps[0], /指定女陪、一陪二附加合计 ¥30\.00/);
  assert.match(explanation.steps[1], /¥150\.00\/位\/小时 × 1位陪玩 × 2小时 = ¥300\.00/);
  assert.equal(explanation.formula, '¥300.00 × 0.95 = ¥285.00');
});

test('娱乐陪一陪二无附加时不虚构一陪二费用', () => {
  const item = priceQuote([row({ tier: '娱乐陪', customerCount: 2 })], customer).items[0];
  assert.match(itemPriceExplanation(item).steps[0], /无收费附加项/);
});

test('混档双陪解释保存分摊额和尾差，汇总不再次扣减整组优惠', () => {
  const quote = priceQuote([row({ hours: 0.5, groupId: 'g', groupDiscountHourlyCents: 1 }), row({ id: 'b', hours: 0.5, tier: '娱乐陪', groupId: 'g', groupDiscountHourlyCents: 1 })], customer);
  const groups = groupPriceExplanations(quote.items);
  assert.equal(groups[0].totalReductionCents, 1);
  assert.equal(groups[0].formula, '整组减免 ¥0.01 = ¥0.01 + ¥0.00（各项分摊，整组只减一次）');
  assert.match(groups[0].allocation, /含尾差/);
  assert.match(itemPriceExplanation(quote.items[0]).formula, /\(¥60\.00 − ¥0\.01\) × 0\.95 = ¥56\.99/);
  assert.equal(quotePriceFormula(quote.items, quote.totalCents), '¥56.99 + ¥28.50 = ¥85.49');
});

test('包时折扣显示此项实际折扣率，未使用的会员折扣不进入式子', () => {
  const item = priceQuote([row({ hours: 6, discount: 'sixHour' })], customer).items[0];
  assert.equal(itemPriceExplanation(item).discountLabel, '6小时包时 9.8折');
  assert.equal(itemPriceExplanation(item).formula, '¥720.00 × 0.98 = ¥705.60');
});

test('体验单固定活动价不因时长、女陪或一陪二而再次乘加', () => {
  const item = priceQuote([row({ kind: 'trial', hours: 3, female: true, customerCount: 2, discount: 'none', promise: '按客服确认的保障安排' })], customer).items[0];
  const explanation = itemPriceExplanation(item);
  assert.equal(explanation.formula, '活动固定价 ¥99.00 = ¥99.00');
  assert.equal(explanation.steps.length, 1);
  assert.match(explanation.notes[0], /不按小时再次相乘/);
});

test('整单式子展示各项最终金额及正负调整，不重复扣折扣', () => {
  const items = [{ totalCents: 12345 }, { totalCents: 5000 }];
  assert.equal(quotePriceFormula(items, 17345), '¥123.45 + ¥50.00 = ¥173.45');
  assert.equal(quotePriceFormula(items, 17845, 500), '¥123.45 + ¥50.00 + ¥5.00 = ¥178.45');
  assert.equal(quotePriceFormula(items, 16345, -1000), '¥123.45 + ¥50.00 − ¥10.00 = ¥163.45');
  assert.equal(quotePriceFormula([], 1500, 1500), '¥0.00 + ¥15.00 = ¥15.00');
});

test('旧报价解释只读取保存快照，不随新价目、附加费或折扣设置变化', () => {
  const old = priceQuote([row({ female: true })], customer).items[0];
  const before = itemPriceExplanation(old);
  const changed = structuredClone(defaultSettings);
  changed.prices['机密']['技术陪'] = 99000;
  changed.femaleHourlyCents = 7000;
  changed.members['白银'].rate = 0.5;
  const newer = priceQuote([row({ female: true })], customer, changed).items[0];
  assert.notEqual(newer.totalCents, old.totalCents);
  assert.deepEqual(itemPriceExplanation(old), before);
  assert.equal(before.formula, '¥260.00 × 0.95 = ¥247.00');
});
