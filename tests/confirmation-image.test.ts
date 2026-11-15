import test from 'node:test';
import assert from 'node:assert/strict';
import { priceQuote, defaultSettings } from '../shared/pricing.ts';
import { itemPriceExplanation } from '../shared/priceExplanation.ts';
import { buildConfirmationDocument, wrapConfirmationText } from '../shared/confirmation.ts';
import { layoutConfirmationImage } from '../src/lib/confirmationImage.ts';
import type { Order, QuoteItemInput } from '../shared/types.ts';

const context = { clubName: '贝蒂电竞俱乐部', playerNames: { requested: '指定人选', assigned: '实际人选' }, parentOrderCode: 'BT-PARENT' };
const input = (patch: Partial<QuoteItemInput> = {}): QuoteItemInput => ({ id: 'item-a', mode: '机密', tier: '技术陪', hours: 2, female: false, customerCount: 1, discount: 'member', groupId: '', plannedStart: '2026-11-16T10:30:00+08:00', requestedPlayerId: 'requested', promise: '约定技术保障，客服协调补打。', kind: 'normal', ...patch });
const order = (items = [input()], patch: Partial<Order> = {}): Order => {
  const quote = priceQuote(items, { member: '红卡', benefit: 'discount' });
  return {
    id: 'order-a', code: 'BT202611160001', customerId: 'customer-a', customerName: '星河', member: '红卡', benefit: 'discount', ...quote,
    adjustmentCents: 0, adjustmentReason: '', quoteVersion: 3, version: 5, notes: 'PRIVATE-INTERNAL-ORDER-NOTE',
    promise: '两位服务同时开始前，请先由客服协调确认。', status: 'draft', refunds: [], assignments: [],
    createdBy: 'creator-a', createdByName: 'PRIVATE-CREATOR-NAME', ownerId: 'owner-a',
    createdAt: '2026-11-16T01:00:00.000Z', updatedAt: '2026-11-16T01:00:00.000Z', ...patch
  };
};
const documentText = (value: unknown) => JSON.stringify(value);
const segments = (text: string) => [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].map(segment => segment.segment);
const measure = (text: string, font: string) => {
  const size = Number(font.match(/([\d.]+)px/)?.[1] || 22);
  return segments(text).reduce((sum, segment) => sum + (/[\u2e80-\uffff]|\p{Extended_Pictographic}/u.test(segment) ? size : size * 0.58), 0);
};

test('确认单包含截图中的完整保存报价解释、手机阅读所需的安排与本单合计', () => {
  const source = order(); const before = structuredClone(source);
  const doc = buildConfirmationDocument(source, context);
  assert.equal(doc.orderCode, 'BT202611160001'); assert.equal(doc.quoteVersion, 3);
  assert.equal(doc.customerName, '星河'); assert.equal(doc.clubName, '贝蒂电竞俱乐部');
  assert.equal(doc.items[0].amount, '¥204.00'); assert.equal(doc.total, '¥204.00');
  assert.equal(doc.items[0].formula, '¥240.00 × 0.85 = ¥204.00');
  assert.deepEqual(doc.items[0].steps, itemPriceExplanation(source.items[0]).steps);
  assert.deepEqual(doc.items[0].notes, itemPriceExplanation(source.items[0]).notes);
  assert.match(doc.items[0].appointment, /2026.*11.*16.*10:30/);
  assert.match(doc.items[0].player, /指定人选/); assert.equal(doc.items[0].promise, source.items[0].promise);
  assert.equal(doc.promise, source.promise); assert.equal(doc.totalFormula, '¥204.00 = ¥204.00');
  const summary = documentText(doc.summaryRows); assert.match(summary, /240\.00/); assert.match(summary, /36\.00/);
  assert.deepEqual(source, before, '生成对客内容不能修改原始订单');
});

test('旧报价不会读取现价，女陪与一陪二显示原报价保存的附加合计', () => {
  const source = order([input({ female: true, customerCount: 2 })]);
  const doc = buildConfirmationDocument(source, context);
  const changed = structuredClone(defaultSettings);
  changed.prices['机密']['技术陪'] = 99000; changed.femaleHourlyCents = 8000; changed.members['红卡'].rate = 0.5;
  const newQuote = priceQuote([input({ female: true, customerCount: 2 })], { member: '红卡', benefit: 'discount' }, changed);
  assert.notEqual(newQuote.totalCents, source.totalCents);
  assert.equal(doc.items[0].formula, '¥300.00 × 0.85 = ¥255.00');
  assert.match(doc.items[0].steps[0], /指定女陪、一陪二附加合计 ¥30\.00/);
  assert.equal(doc.total, '¥255.00'); assert.deepEqual(buildConfirmationDocument(source, context), doc);
});

test('混档双陪显示整组分摊及尾差，汇总使用各项折后金额而不重复减优惠', () => {
  const source = order([
    input({ hours: 0.5, groupId: 'mixed', groupDiscountHourlyCents: 1 }),
    input({ id: 'item-b', tier: '娱乐陪', hours: 0.5, groupId: 'mixed', groupDiscountHourlyCents: 1 })
  ]);
  const doc = buildConfirmationDocument(source, context);
  assert.equal(doc.items[0].amount, '¥50.99'); assert.equal(doc.items[1].amount, '¥25.50');
  assert.equal(doc.totalFormula, '¥50.99 + ¥25.50 = ¥76.49'); assert.equal(doc.total, '¥76.49');
  assert.match(doc.groups[0].formula, /整组减免 ¥0\.01 = ¥0\.01 \+ ¥0\.00/);
  assert.match(doc.groups[0].allocation, /尾差/);
  assert.match(doc.items[0].formula, /\(¥60\.00 − ¥0\.01\) × 0\.85 = ¥50\.99/);
});

test('99元体验只显示固定活动价，不把购买时长重复相乘', () => {
  const doc = buildConfirmationDocument(order([input({ kind: 'trial', hours: 3, discount: 'none', promise: '888W／包撤离，以本单约定为准' })]), context);
  assert.equal(doc.items[0].amount, '¥99.00'); assert.equal(doc.total, '¥99.00');
  assert.equal(doc.items[0].formula, '活动固定价 ¥99.00 = ¥99.00');
  assert.match(documentText(doc.items[0].notes), /不按小时再次相乘/);
  assert.match(documentText(doc.items[0]), /888W/);
});

test('补款单保留关联原单与金额说明，不新增服务或重复叠加补款', () => {
  const source = order(undefined, { kind: 'supplement', items: [], subtotalCents: 0, groupDiscountCents: 0, discountCents: 0, totalCents: 2500, adjustmentCents: 2500, adjustmentReason: '客户确认额外约定费用', parentOrderId: 'original-order' });
  const doc = buildConfirmationDocument(source, context);
  assert.deepEqual(doc.items, []); assert.equal(doc.total, '¥25.00');
  assert.equal(doc.totalFormula, '¥0.00 + ¥25.00 = ¥25.00');
  assert.match(documentText(doc), /BT-PARENT/); assert.match(documentText(doc), /客户确认额外约定费用/);
  assert.match(documentText(layoutConfirmationImage(doc, measure).commands), /不新增服务/);
});

test('整单减免至零仍给出准确合计和约定原因，订单状态不冒充待付款', () => {
  const zero = order(undefined, { adjustmentCents: -20400, adjustmentReason: '本次约定全部减免', totalCents: 0 });
  const doc = buildConfirmationDocument(zero, context);
  assert.equal(doc.total, '¥0.00'); assert.equal(doc.totalFormula, '¥204.00 − ¥204.00 = ¥0.00');
  assert.match(documentText(doc), /本次约定全部减免/);
  const cancelled = buildConfirmationDocument(order(undefined, { status: 'cancelled' }), context);
  assert.match(`${cancelled.statusLabel} ${cancelled.statusNotice}`, /取消/);
  const paid = buildConfirmationDocument(order(undefined, { status: 'paid', payment: { id: 'pay-a', walletCents: 20400, externalCents: 0, channel: '', reference: 'PRIVATE-PAYMENT-REFERENCE', note: 'PRIVATE-PAYMENT-NOTE', actorId: 'actor-a', actorName: 'PRIVATE-PAYMENT-ACTOR', createdAt: '2026-11-16T02:00:00.000Z' } }), context);
  assert.match(`${paid.statusLabel} ${paid.statusNotice}`, /结清|已付款/);
  assert.equal(paid.total, '¥204.00');
});

test('对客文档只取允许字段，内部备注、应得与凭证不会进入图片', () => {
  const source = order(undefined, {
    assignments: [
      { id: 'assignment-old', itemId: 'item-a', playerId: 'old', playerName: '旧人选', status: 'replaced', assignedAt: '2026-11-16T01:01:00Z', freeMinutes: 0, earningCents: 987654, settled: true, reason: 'PRIVATE-OLD-ASSIGNMENT-REASON' },
      { id: 'assignment-new', itemId: 'item-a', playerId: 'assigned', playerName: '实际人选', status: 'assigned', assignedAt: '2026-11-16T01:02:00Z', freeMinutes: 30, freeReason: 'PRIVATE-FREE-REASON', earningCents: 876543, settled: true, reason: 'PRIVATE-NEW-ASSIGNMENT-REASON' }
    ],
    payment: { id: 'payment-a', walletCents: 20400, externalCents: 0, channel: 'PRIVATE-CHANNEL', reference: 'PRIVATE-REFERENCE', note: 'PRIVATE-PAYMENT-NOTE', actorId: 'PRIVATE-ACTOR-ID', actorName: 'PRIVATE-ACTOR-NAME', createdAt: '2026-11-16T02:00:00.000Z' },
    refunds: [{ id: 'refund-a', walletCents: 100, externalCents: 0, reason: 'PRIVATE-REFUND-REASON', reference: 'PRIVATE-REFUND-REF', actorId: 'PRIVATE-REFUND-ACTOR', actorName: 'PRIVATE-REFUND-ACTOR-NAME', createdAt: '2026-11-16T02:30:00.000Z' }]
  });
  const doc = buildConfirmationDocument(source, context);
  assert.match(doc.items[0].player, /实际人选/); assert.doesNotMatch(doc.items[0].player, /旧人选/);
  const text = documentText(doc); assert.doesNotMatch(text, /PRIVATE-|987654|876543|earningCents|passwordHash/);
});

test('长中文、连续英文和组合emoji按字素换行，不丢失字符或拆开组合', () => {
  const family = '👨‍👩‍👧‍👦'; const text = `长中文开头${family}e\u0301ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890结束`;
  const lines = wrapConfirmationText(text, 4, value => segments(value).length);
  assert.equal(lines.join(''), text); assert.ok(lines.length > 1);
  assert.ok(lines.every(line => segments(line).length <= 4)); assert.ok(lines.some(line => line.includes(family)));
  assert.ok(lines.some(line => line.includes('e\u0301')));
  assert.deepEqual(wrapConfirmationText('第一行\n\n第三行', 20, value => segments(value).length), ['第一行', '', '第三行']);
  assert.deepEqual(wrapConfirmationText(family, 0.5, () => 1), [family]);
});

test('中文句号与连续闭合标点随前一个字一起换行，不形成孤立标点行', () => {
  const count = (value: string) => segments(value).length;
  const cases: [string, number, string[]][] = [
    ['甲乙丙。', 3, ['甲乙', '丙。']],
    ['甲乙丙）。', 3, ['甲乙', '丙）。']],
    ['甲乙丙！？', 3, ['甲乙', '丙！？']],
    ['甲乙丙， 后续。', 3, ['甲乙', '丙， ', '后续。']]
  ];
  for (const [value, width, expected] of cases) {
    const lines = wrapConfirmationText(value, width, count);
    assert.deepEqual(lines, expected); assert.equal(lines.join(''), value);
    assert.ok(lines.every(line => count(line) <= width));
    assert.ok(lines.every(line => !/^[。，、：；！？）》」』】”’]/u.test(line.trimStart())));
  }
  const promise = '技术保障以下单确认内容为准，客服协调补打。';
  const font = '400 22px sans-serif';
  const lines = wrapConfirmationText(promise, measure(promise.slice(0, -1), font), value => measure(value, font));
  assert.equal(lines.join(''), promise); assert.notEqual(lines.at(-1), '。'); assert.ok(lines.at(-1)!.endsWith('打。'));
});

test('开放括号引号连同相邻空格移至下一行，不留在自动换行的行尾', () => {
  const count = (value: string) => segments(value).length;
  for (const [value, width] of [['甲乙（丙丁）', 3], ['甲乙（ 丙丁）。', 4], ['「甲乙」丙丁。', 3]] as const) {
    const lines = wrapConfirmationText(value, width, count);
    assert.equal(lines.join(''), value); assert.ok(lines.every(line => count(line) <= width));
    assert.ok(lines.slice(0, -1).every(line => !/[（《「『【“‘]$/u.test(line.trimEnd())));
    assert.ok(lines.every(line => !/^[。，、：；！？）》」』】”’]/u.test(line.trimStart())));
  }
  assert.deepEqual(wrapConfirmationText('甲乙（ 丙丁）。', 4, count), ['甲乙', '（ 丙', '丁）。']);
});

test('字素与空格位于标点断行边界时仍完整保留，组合emoji不被拆开', () => {
  const count = (value: string) => segments(value).length;
  const family = '👨‍👩‍👧‍👦';
  for (const value of [`甲乙${family}。`, '甲乙e\u0301。']) {
    const lines = wrapConfirmationText(value, 3, count);
    assert.equal(lines.join(''), value); assert.equal(lines.length, 2);
    assert.ok(lines.every(line => count(line) <= 3)); assert.ok(lines[1].endsWith('。'));
    assert.equal(count(lines[1]), 2, '末行必须包含一个完整字素和它的句号');
  }
  assert.deepEqual(wrapConfirmationText(`甲乙${family}。`, 3, count), ['甲乙', `${family}。`]);
  const spaced = '甲乙  丙。'; const lines = wrapConfirmationText(spaced, 4, count);
  assert.deepEqual(lines, ['甲乙  ', '丙。']); assert.equal(lines.join(''), spaced);
});

test('中文禁则不改写用户显式换行，极窄行宽优先保留字符且不溢出', () => {
  const count = (value: string) => segments(value).length;
  const explicit = '甲乙。\n\n。丙（\n丁）。';
  assert.deepEqual(wrapConfirmationText(explicit, 20, count), ['甲乙。', '', '。丙（', '丁）。']);
  const lines = wrapConfirmationText('甲。', 1, count);
  assert.deepEqual(lines, ['甲', '。']); assert.equal(lines.join(''), '甲。');
  assert.ok(lines.every(line => count(line) <= 1));
});

test('图片布局固定横向宽度，项目及长承诺只增加纵向高度且保留尾部内容', () => {
  const single = buildConfirmationDocument(order(), context);
  const many = buildConfirmationDocument(order(Array.from({ length: 30 }, (_, index) => input({ id: `item-${index}`, requestedPlayerId: '', plannedStart: '', promise: '' }))), context);
  const long = buildConfirmationDocument(order([input({ promise: '这一段对客约定必须完整展示。'.repeat(18) + '最终保障内容结束' })]), context);
  const oneLayout = layoutConfirmationImage(single, measure); const manyLayout = layoutConfirmationImage(many, measure); const longLayout = layoutConfirmationImage(long, measure);
  assert.equal(oneLayout.width, 540); assert.equal(manyLayout.width, oneLayout.width); assert.equal(longLayout.width, oneLayout.width);
  assert.ok(manyLayout.height > oneLayout.height * 5); assert.ok(longLayout.height > oneLayout.height);
  assert.match(longLayout.commands.filter(command => command.type === 'text').map(command => command.text).join(''), /最终保障内容结束/);
  for (const command of longLayout.commands) {
    assert.ok(command.y >= 0 && command.y < longLayout.height, '所有内容必须位于图片纵向边界内');
    if (command.type === 'text') assert.ok(command.x + measure(command.text, command.font) <= longLayout.width + 0.01, '长文本不能超出图片横向边界');
    if (command.type === 'box') assert.ok(command.y + command.height <= longLayout.height, '卡片背景不能被图片截断');
  }
  assert.ok(Number.isFinite(manyLayout.height));
});

test('最大长度承诺导致超长图片时明确提示，不能静默丢弃订单尾部', () => {
  const maximumText = '客户服务保障与安排说明'.repeat(200).slice(0, 2000);
  const source = order(Array.from({ length: 30 }, (_, index) => input({ id: `max-item-${index}`, promise: maximumText })), { promise: maximumText });
  const doc = buildConfirmationDocument(source, context);
  assert.equal(doc.items.length, 30); assert.equal(doc.items[29].promise, maximumText);
  assert.throws(() => layoutConfirmationImage(doc, measure), /超出|过长|安全尺寸/);
});
