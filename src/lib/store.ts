import { reactive, ref } from 'vue';
import type { Bootstrap, Permission } from '../../shared/types';
import { defaultSettings } from '../../shared/pricing';
import { api } from './api';
export const authenticated = ref(false);
export const state = reactive<Bootstrap>({ user: {id:'',username:'',name:'',role:'staff',permissions:[],active:false}, customers:[],players:[],orders:[],ledger:[],recharges:[],audit:[],staff:[],accounts:[], settings: structuredClone(defaultSettings), dashboard: {customers:0,players:0,pendingPayment:0,pendingDispatch:0,serving:0,completed:0,orderTotalCents:0,rechargeCents:0,externalOrderCents:0,walletConsumedCents:0,refundCents:0,externalRefundCents:0,cashReceivedCents:0,walletLiabilityCents:0,earningsCents:0,daily:[]} });
let refreshing: Promise<void> | null = null;
export async function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async()=>{ const data = await api<Bootstrap>('/api/bootstrap');Object.assign(state,data);authenticated.value=true; })();
  try { await refreshing; } finally { refreshing=null; }
}
export function can(permission: Permission | string): boolean { return state.user.role === 'admin' || state.user.permissions.includes(permission as Permission); }
export function orderProgress(order: Bootstrap['orders'][number]): string {
  if(order.status==='cancelled')return '已取消';if(order.status==='draft')return '待客户确认';if(order.status==='confirmed')return '待结清';
  if(order.kind==='supplement')return '已结清补款';
  const live=order.assignments.filter(a=>a.status!=='replaced'&&a.status!=='cancelled');
  if(live.length>=order.items.length&&live.every(a=>a.status==='completed'))return '已完成';
  if(live.some(a=>a.status==='serving'))return '服务中';if(live.length===0)return '待派单';if(live.length<order.items.length)return '部分派单';return '待服务';
}
