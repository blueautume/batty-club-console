import { it } from 'node:test';
import assert from 'node:assert/strict';
import { registerEditorLeaveGuard, requestEditorLeave } from '../src/lib/leaveGuard.ts';

it('资金处理对话框不会覆盖父页面的未保存检查，关闭后仍保留父检查', async () => {
  let parentCanLeave = false;
  const closeParent = registerEditorLeaveGuard(async () => parentCanLeave);
  const closeDialog = registerEditorLeaveGuard(async () => true);
  try {
    assert.equal(await requestEditorLeave('logout'), false);
    closeDialog();
    assert.equal(await requestEditorLeave('navigation'), false);
    parentCanLeave = true;
    assert.equal(await requestEditorLeave('navigation'), true);
  } finally { closeDialog(); closeParent(); }
});

it('父页面允许离开时，尚未保存完的退款仍阻止退出；卸载只移除自己的检查', async () => {
  let refundSaving = true;
  const closeParent = registerEditorLeaveGuard(async () => true);
  const closeRefund = registerEditorLeaveGuard(async () => !refundSaving);
  try {
    assert.equal(await requestEditorLeave('logout'), false);
    closeParent();
    assert.equal(await requestEditorLeave('navigation'), false);
    refundSaving = false;
    assert.equal(await requestEditorLeave('logout'), true);
  } finally { closeRefund(); closeParent(); }
  assert.equal(await requestEditorLeave('navigation'), true);
});
