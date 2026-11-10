import test from 'node:test';
import assert from 'node:assert/strict';
import { listQuoteRecoveries, readQuoteRecovery, writeQuoteRecovery, removeQuoteRecovery, restoredQuoteRecoverySource, syncQuoteRecovery } from '../src/lib/quoteRecovery.ts';
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

test('恢复旧版填写后再次备份和刷新仍保留原版本与冲突，不能冒充服务器新版本',()=>{
  const storage=new MemoryStorage();
  const original={...recovery('a'),serverDraftId:'draft-1',serverVersion:1};
  const current={id:'draft-1',version:2};
  let cached=original;
  for(let reload=0;reload<3;reload++) {
    const source=restoredQuoteRecoverySource(cached,current);
    assert.equal(source.serverVersion,1);
    assert.equal(source.conflicted,true);
    const next={...cached,...source};
    assert.equal(syncQuoteRecovery(next,JSON.stringify({...next.payload,notes:'服务器已保存的新版本'}),storage),true);
    cached=readQuoteRecovery('a','tab-a',storage)! as typeof original;
    assert.equal(cached.payload.notes,'未填完的备注');
  }
  assert.equal(restoredQuoteRecoverySource({...cached,conflicted:true},{id:'draft-1',version:1}).conflicted,true);
});

test('原草稿已归档、不可读取或标记冲突时恢复不会丢失草稿关联',()=>{
  const cached={...recovery('a'),serverDraftId:'converted-draft',serverVersion:4};
  const source=restoredQuoteRecoverySource(cached,null);
  assert.deepEqual(source,{serverDraftId:'converted-draft',serverVersion:4,pendingCreation:undefined,conflicted:true});
  assert.equal(restoredQuoteRecoverySource({...cached,serverVersion:undefined},{id:'converted-draft',version:5}).conflicted,true);
  assert.equal(restoredQuoteRecoverySource(cached,{id:'other-draft',version:4}).conflicted,true);
  assert.equal(restoredQuoteRecoverySource(recovery('a'),null).conflicted,false);
  assert.equal(restoredQuoteRecoverySource(cached,{id:'converted-draft',version:4}).conflicted,false);
});

test('填写撤销回已暂存版本时清除当前过期备份，稍后恢复的其他填写仍保留',()=>{
  const storage=new MemoryStorage();
  const saved=recovery('a'), baseline=JSON.stringify(saved.payload);
  const parked={...recovery('a','parked-edit'),payload:{...saved.payload,notes:'已选择稍后恢复'}};
  writeQuoteRecovery(parked,storage);
  assert.equal(syncQuoteRecovery({...saved,payload:{...saved.payload,notes:'临时改动'}},baseline,storage),true);
  assert.equal(readQuoteRecovery('a','tab-a',storage)?.payload.notes,'临时改动');
  assert.equal(syncQuoteRecovery(saved,baseline,storage),true);
  assert.equal(readQuoteRecovery('a','tab-a',storage),null);
  assert.equal(readQuoteRecovery('a','parked-edit',storage)?.payload.notes,'已选择稍后恢复');
});

test('内容恰好等于服务器时也保留已标记冲突的本机备份，存储失败可被编辑器感知',()=>{
  const storage=new MemoryStorage(), cached={...recovery('a'),conflicted:true,serverDraftId:'d',serverVersion:1};
  assert.equal(syncQuoteRecovery(cached,JSON.stringify(cached.payload),storage),true);
  assert.equal(readQuoteRecovery('a','tab-a',storage)?.conflicted,true);
  const blocked:RecoveryStorage={length:0,key:()=>null,getItem:()=>null,setItem:()=>{throw new Error('quota');},removeItem:()=>{throw new Error('blocked');}};
  assert.equal(syncQuoteRecovery(cached,JSON.stringify(cached.payload),blocked),false);
  assert.equal(syncQuoteRecovery({...cached,conflicted:false},JSON.stringify(cached.payload),blocked),false);
});

test('首次暂存响应丢失时保留创建请求标记和原恢复编号，空表单也能以同一编号重试',()=>{
  const storage=new MemoryStorage(), original={...recovery('a','creation-request'),pendingCreation:true};
  const baseline=JSON.stringify(original.payload);
  assert.equal(syncQuoteRecovery(original,baseline,storage),true);
  const cached=readQuoteRecovery('a','creation-request',storage)!;
  assert.equal(cached.id,'creation-request');
  const source=restoredQuoteRecoverySource(cached,null);
  assert.equal(source.pendingCreation,true);
  assert.equal(source.conflicted,false);
  assert.equal(syncQuoteRecovery({...cached,...source},baseline,storage),true);
  const acknowledged={...cached,pendingCreation:false,serverDraftId:'created-once',serverVersion:1};
  assert.equal(syncQuoteRecovery(acknowledged,baseline,storage),true);
  assert.equal(readQuoteRecovery('a','creation-request',storage),null);
});
