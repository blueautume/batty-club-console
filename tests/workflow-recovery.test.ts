import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkflowSubmission, saveWorkflowSubmission, clearWorkflowSubmission } from '../src/lib/workflowRecovery.ts';

function browserStorage() {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  return { values, close() { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else Reflect.deleteProperty(globalThis, 'sessionStorage'); } };
}

it('资金提交响应丢失后恢复原路径、金额、操作编号，不能变成一笔新退款', () => {
  const storage = browserStorage();
  try {
    const submitted = { path: '/api/workflow/execute', body: JSON.stringify({ plan: { action: 'orderCancel', targetId: 'order-1', reason: '客户取消', walletCents: 10000, externalCents: 20000 }, idempotencyKey: 'first-payment-operation' }), createdAt: '2026-11-18T01:00:00.000Z' };
    saveWorkflowSubmission('staff-1', 'action', submitted);
    assert.deepEqual(readWorkflowSubmission('staff-1', 'action'), submitted);
    assert.equal(JSON.parse(readWorkflowSubmission('staff-1', 'action')!.body).idempotencyKey, 'first-payment-operation');
    assert.equal(readWorkflowSubmission('staff-2', 'action'), null);
  } finally { storage.close(); }
});

it('外部退款登记与业务申请分别恢复，核实一笔不会丢失另一笔待核对内容', () => {
  const storage = browserStorage();
  try {
    const action = { path: '/api/workflow/requests', body: '{"plan":{"action":"orderRefund"},"idempotencyKey":"apply-1"}', createdAt: '2026-11-18T01:00:00.000Z' };
    const completion = { path: '/api/workflow/requests/request-1/complete', body: '{"version":2,"reference":"ACTUAL-REFUND-1","idempotencyKey":"complete-1"}', requestId: 'request-1', createdAt: '2026-11-18T02:00:00.000Z' };
    saveWorkflowSubmission('admin-1', 'action', action);
    saveWorkflowSubmission('admin-1', 'completion', completion);
    assert.deepEqual(readWorkflowSubmission('admin-1', 'completion'), completion);
    clearWorkflowSubmission('admin-1', 'completion');
    assert.equal(readWorkflowSubmission('admin-1', 'completion'), null);
    assert.deepEqual(readWorkflowSubmission('admin-1', 'action'), action);
  } finally { storage.close(); }
});

it('损坏的本机恢复内容不会被作为业务请求发送', () => {
  const storage = browserStorage();
  try {
    storage.values.set('batty:workflow:action:staff-1', '{broken');
    assert.equal(readWorkflowSubmission('staff-1', 'action'), null);
    storage.values.set('batty:workflow:action:staff-1', JSON.stringify({ path: 'https://example.com/refund', body: '{}', createdAt: '' }));
    assert.equal(readWorkflowSubmission('staff-1', 'action'), null);
    storage.values.set('batty:workflow:action:staff-1', JSON.stringify({ path: '/api/workflow/execute', body: 'null', createdAt: '' }));
    assert.equal(readWorkflowSubmission('staff-1', 'action'), null);
  } finally { storage.close(); }
});
