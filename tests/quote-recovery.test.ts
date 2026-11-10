import test from 'node:test';
import assert from 'node:assert/strict';
import { listQuoteRecoveries, readQuoteRecovery, writeQuoteRecovery, removeQuoteRecovery } from '../src/lib/quoteRecovery.ts';
import type { QuoteRecovery, RecoveryStorage } from '../src/lib/quoteRecovery.ts';
class MemoryStorage implements RecoveryStorage {
  data = new Map<string,string>();
  get length() { return this.data.size; }
  key(index:number) { return [...this.data.keys()][index] ?? null; }
  getItem(key:string) { return this.data.get(key) ?? null; }
  setItem(key:string,value:string) { this.data.set(key,value); }
  removeItem(key:string) { this.data.delete(key); }
}
const recovery = (userId:string,id='tab-a'):QuoteRecovery => ({id,userId,title:'未完成的组合报价',updatedAt:'2026-11-11T01:00:00Z',payload:{customerId:'',items:[{hours:null,tier:'技术陪'}],notes:'未填完的备注',promise:'',adjustment:0,adjustmentReason:'',ownerId:userId,parentOrderId:''}});
test('刷新恢复缓存保留未选择客户和清空数值的表单',()=>{const storage=new MemoryStorage();const value=recovery('a');assert.equal(writeQuoteRecovery(value,storage),true);assert.deepEqual(readQuoteRecovery('a','tab-a',storage),value);});
test('本机恢复缓存按工作人员隔离且支持多个标签页',()=>{const storage=new MemoryStorage();writeQuoteRecovery(recovery('a','tab-a'),storage);writeQuoteRecovery(recovery('a','tab-b'),storage);writeQuoteRecovery(recovery('b','tab-a'),storage);assert.equal(listQuoteRecoveries('a',storage).length,2);assert.equal(listQuoteRecoveries('b',storage).length,1);assert.equal(readQuoteRecovery('b','tab-b',storage),null);removeQuoteRecovery('a','tab-a',storage);assert.equal(listQuoteRecoveries('b',storage).length,1);});
test('损坏缓存或存储权限失败不会破坏开单',()=>{const storage=new MemoryStorage();writeQuoteRecovery(recovery('a'),storage);const first=storage.key(0)!;storage.setItem(first,'invalid json');assert.equal(readQuoteRecovery('a','tab-a',storage),null);assert.deepEqual(listQuoteRecoveries('a',storage),[]);const blocked={...storage,length:0,key:()=>null,getItem:()=>null,removeItem:()=>{},setItem:()=>{throw new Error('quota');}};assert.equal(writeQuoteRecovery(recovery('a'),blocked),false);});
test('缓存内伪造的所属账号不被恢复',()=>{const storage=new MemoryStorage();writeQuoteRecovery(recovery('a'),storage);const first=storage.key(0)!;storage.setItem(first,JSON.stringify(recovery('b')));assert.equal(readQuoteRecovery('a','tab-a',storage),null);});
