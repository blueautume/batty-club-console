import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';

async function fixture() {
  const service = createApp({ dbPath: ':memory:' });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  async function login(username='admin',password='Batty2026!') { assert.equal((await request('/api/login',{username,password})).status,200); }
  const bootstrap = async () => (await request('/api/bootstrap')).data;
  const item = (patch={}) => ({ id: crypto.randomUUID(), mode: '机密', tier: '技术陪', hours: 1, female: false, customerCount: 1, discount: 'none', groupId: '', plannedStart: '', requestedPlayerId: '', promise: '', kind: 'normal', ...patch });
  const newOrder = async (items=[item()],patch={}) => { const customer = (await bootstrap()).customers.find((c:any)=>c.member==='普通客户'); const result=await request('/api/orders',{customerId:customer.id,items,...patch}); assert.equal(result.status,201); return result.data; };
  const pay = async (order:any) => { const confirmed=await request(`/api/orders/${order.id}/confirm`,{version:order.version,quoteVersion:order.quoteVersion}); assert.equal(confirmed.status,200); const paid=await request(`/api/orders/${order.id}/pay`,{version:confirmed.data.version,quoteVersion:order.quoteVersion,walletCents:0,externalCents:order.totalCents,channel:order.totalCents?'微信转账':'',reference:order.totalCents?crypto.randomUUID():''}); assert.equal(paid.status,200);return paid.data; };
  const assign = async (order:any,itemId=order.items[0].id) => { const player=(await bootstrap()).players.find((p:any)=>p.status==='available'&&p.capabilities.some((c:any)=>c.mode==='机密'&&c.tier==='技术陪')); return request(`/api/orders/${order.id}/assign`,{itemId,playerId:player.id}); };
  const close = async () => { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));service.close(); };
  return { request,login,bootstrap,item,newOrder,pay,assign,close };
}

describe('跨流程边界回归', {concurrency:false},()=>{
  it('全部减免至零元后仍可确认、结清、派单和完成，且不会伪造退款或余额流水',async()=>{
    const f=await fixture();try{
      await f.login(); const order=await f.newOrder();
      const adjusted=await f.request(`/api/orders/${order.id}/adjustment`,{version:order.version,quoteVersion:order.quoteVersion,amountCents:-order.totalCents,reason:'负责人确认免费体验安排',idempotencyKey:crypto.randomUUID()}); assert.equal(adjusted.status,200);
      const paid=await f.pay(adjusted.data); const before=await f.bootstrap();
      const assigned=await f.assign(paid); assert.equal(assigned.status,200,JSON.stringify(assigned.data));
      const aid=assigned.data.assignments[0].id;
      assert.equal((await f.request(`/api/orders/${paid.id}/assignment/${aid}`,{action:'start'})).status,200);
      assert.equal((await f.request(`/api/orders/${paid.id}/assignment/${aid}`,{action:'complete'})).status,200);
      const after=await f.bootstrap(); const saved=after.orders.find((o:any)=>o.id===paid.id);
      assert.equal(saved.refunds.length,0); assert.equal(saved.totalCents,0); assert.equal(after.dashboard.completed,before.dashboard.completed+1);assert.equal(after.dashboard.pendingDispatch,0);
      assert.equal(after.ledger.filter((l:any)=>l.orderId===paid.id).length,0);
      assert.equal((await f.request(`/api/orders/${paid.id}/refund`,{walletCents:1,externalCents:0,reason:'免费单不可退款',idempotencyKey:crypto.randomUUID()})).status,400);
    } finally {await f.close();}
  });
  it('零元已结清订单可取消剩余服务，派单同步取消且不能再开始',async()=>{
    const f=await fixture();try{
      await f.login(); const paid=await f.pay(await f.newOrder(undefined,{adjustmentCents:-12000,adjustmentReason:'全部费用由俱乐部承担'}));
      const assigned=await f.assign(paid);assert.equal(assigned.status,200);const aid=assigned.data.assignments[0].id;
      const cancelled=await f.request(`/api/orders/${paid.id}/cancel`,{reason:'客户取消免费体验'});assert.equal(cancelled.status,200,JSON.stringify(cancelled.data));
      assert.equal(cancelled.data.status,'cancelled');assert.equal(cancelled.data.assignments[0].status,'cancelled');assert.ok(cancelled.data.assignments[0].endedAt);
      assert.equal((await f.request(`/api/orders/${paid.id}/assignment/${aid}`,{action:'start'})).status,409);
      assert.equal(cancelled.data.refunds.length,0);
    }finally{await f.close();}
  });
  it('整单负调价保守扣减客服的未开始部分退款额度，不能退入已消费部分',async()=>{
    const f=await fixture();try{
      await f.login();const paid=await f.pay(await f.newOrder([f.item(),f.item({tier:'娱乐陪'})],{adjustmentCents:-10000,adjustmentReason:'整单特殊减免，不指定分摊服务'}));
      assert.equal(paid.totalCents,8000);const assigned=await f.assign(paid);assert.equal(assigned.status,200);await f.request(`/api/orders/${paid.id}/assignment/${assigned.data.assignments[0].id}`,{action:'start'});
      await f.login('kefu','Staff2026!');
      const refunded=await f.request(`/api/orders/${paid.id}/refund`,{walletCents:0,externalCents:6000,reason:'尝试按原未开始价退款',reference:'staff-over-adjusted-limit',idempotencyKey:crypto.randomUUID()});assert.equal(refunded.status,403,JSON.stringify(refunded.data));
      await f.login();const adminRefund=await f.request(`/api/orders/${paid.id}/refund`,{walletCents:0,externalCents:6000,reason:'管理员核实并授权特殊退费',reference:'admin-adjusted-refund',idempotencyKey:crypto.randomUUID()});assert.equal(adminRefund.status,200);
    }finally{await f.close();}
  });
  it('同一赠时请求重试只增加一次，复用编号改变内容或目标不能继续赠送',async()=>{
    const f=await fixture();try{
      await f.login();const paid=await f.pay(await f.newOrder());const assigned=await f.assign(paid);assert.equal(assigned.status,200);const aid=assigned.data.assignments[0].id;
      const body={action:'free',minutes:10,reason:'漏提醒约定补足10分钟',idempotencyKey:crypto.randomUUID()};
      const results=await Promise.all([f.request(`/api/orders/${paid.id}/assignment/${aid}`,body),f.request(`/api/orders/${paid.id}/assignment/${aid}`,body)]);
      assert.deepEqual(results.map(result=>result.status),[200,200]);assert.deepEqual(results.map(result=>result.data.assignments[0].freeMinutes),[10,10]);
      assert.equal((await f.request(`/api/orders/${paid.id}/assignment/${aid}`,{...body,minutes:20})).status,409);
      assert.equal((await f.request(`/api/orders/${paid.id}/assignment/not-this-assignment`,body)).status,409);
      const state=await f.bootstrap();assert.equal(state.audit.filter((a:any)=>a.targetId===paid.id&&a.action==='登记免费补时或补打').length,1);
      assert.equal(state.orders.find((o:any)=>o.id===paid.id).assignments[0].freeMinutes,10);
    }finally{await f.close();}
  });
  it('收款与补款始终使用订单主客户，不能通过提交另一客户编号借用余额',async()=>{
    const f=await fixture();try{
      await f.login();const order=await f.newOrder(), before=await f.bootstrap();
      const other=before.customers.find((c:any)=>c.id!==order.customerId&&c.balanceCents>=order.totalCents);
      const confirmed=(await f.request(`/api/orders/${order.id}/confirm`,{version:order.version,quoteVersion:order.quoteVersion})).data;
      const forbidden=await f.request(`/api/orders/${order.id}/pay`,{version:confirmed.version,quoteVersion:confirmed.quoteVersion,customerId:other.id,walletCents:order.totalCents,externalCents:0});
      assert.equal(forbidden.status,409);
      const after=await f.bootstrap();assert.deepEqual(after.customers.map((c:any)=>[c.id,c.balanceCents]),before.customers.map((c:any)=>[c.id,c.balanceCents]));
      const paid=(await f.request(`/api/orders/${order.id}/pay`,{version:confirmed.version,quoteVersion:confirmed.quoteVersion,customerId:other.id,walletCents:0,externalCents:order.totalCents,channel:'微信转账',reference:crypto.randomUUID()})).data;
      assert.equal(paid.customerId,order.customerId);
      const supplement=await f.request(`/api/orders/${paid.id}/supplement`,{version:paid.version,quoteVersion:paid.quoteVersion,customerId:other.id,amountCents:1000,reason:'仅属于原主客户的补款',idempotencyKey:crypto.randomUUID()});
      assert.equal(supplement.status,201);assert.equal(supplement.data.customerId,order.customerId);assert.equal(supplement.data.parentOrderId,order.id);
      assert.equal((await f.request(`/api/orders/${order.id}/refund`,{walletCents:1,externalCents:0,reason:'不能把外部款按其他钱包退回',idempotencyKey:crypto.randomUUID()})).status,400);
    }finally{await f.close();}
  });
  it('首次草稿暂存响应丢失后重试不重复创建，按账号隔离且不能覆盖已变更或已转单的草稿',async()=>{
    const f=await fixture();try{
      await f.login();const creationKey=crypto.randomUUID(), payload={notes:'首次草稿响应丢失后仍需找回',items:[f.item()]};
      const first=await f.request('/api/quote-drafts',{creationKey,payload});assert.equal(first.status,201);
      const retry=await f.request('/api/quote-drafts',{creationKey,payload,automatic:true});assert.equal(retry.status,200);assert.equal(retry.data.id,first.data.id);
      assert.equal((await f.request('/api/quote-drafts')).data.length,1);
      assert.equal((await f.bootstrap()).audit.filter((a:any)=>a.targetId===first.data.id).length,1);
      assert.equal((await f.request('/api/quote-drafts',{creationKey,payload:{...payload,notes:'同一创建编号不能偷换内容'}})).status,409);
      const edited=await f.request(`/api/quote-drafts/${first.data.id}`,{version:1,payload:{...payload,notes:'另一窗口已经保存新内容'}},'PUT');assert.equal(edited.status,200);
      assert.equal((await f.request('/api/quote-drafts',{creationKey,payload})).status,409);
      assert.equal((await f.request(`/api/quote-drafts/${first.data.id}`)).data.payload.notes,'另一窗口已经保存新内容');
      await f.login('kefu','Staff2026!');const staff=await f.request('/api/quote-drafts',{creationKey,payload});assert.equal(staff.status,201);assert.notEqual(staff.data.id,first.data.id);assert.equal(staff.data.ownerId,'staff-demo');
      assert.equal((await f.request('/api/quote-drafts',{creationKey,payload})).data.id,staff.data.id);
      await f.login();const customer=(await f.bootstrap()).customers.find((c:any)=>c.member==='普通客户'), items=[f.item()], convertedKey=crypto.randomUUID(), convertedPayload={customerId:customer.id,items};
      const source=(await f.request('/api/quote-drafts',{creationKey:convertedKey,payload:convertedPayload})).data;
      const order=await f.request('/api/orders',{customerId:customer.id,items,sourceDraftId:source.id,expectedDraftVersion:source.version});assert.equal(order.status,201);
      const count=(await f.bootstrap()).orders.length;
      assert.equal((await f.request('/api/quote-drafts',{creationKey:convertedKey,payload:convertedPayload})).status,409);
      assert.equal((await f.bootstrap()).orders.length,count);
      assert.equal((await f.request('/api/quote-drafts')).data.length,1);
    }finally{await f.close();}
  });
});
