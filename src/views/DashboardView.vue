<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Plus, ArrowRight, Refresh, Clock, User, Tickets, Headset, Wallet, TrendCharts } from '@element-plus/icons-vue';
import { state, refresh } from '../lib/store';
import { money, notifyError } from '../lib/api';
import type { Order } from '../../shared/types';

const router = useRouter();
const loading = ref(false);
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => { ticker = setInterval(() => { now.value = Date.now(); }, 30000); });
onBeforeUnmount(() => { if (ticker) clearInterval(ticker); });
const dateKey = (value: string | number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(value));
const today = computed(() => dateKey(now.value));
const todayOrders = computed(() => state.orders.filter((o: Order) => dateKey(o.createdAt) === today.value));
const greeting = computed(() => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(now.value)));
  return hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';
});
const dateText = computed(() => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' }).format(new Date(now.value)));
const myOrders = computed(() => state.orders.filter((o: Order) => o.ownerId === state.user?.id && o.status !== 'cancelled').slice(0, 6));
const daily = computed(() => state.dashboard?.daily || []);
const maxDaily = computed(() => Math.max(1, ...daily.value.map((d) => d.amountCents)));
const reminders = computed(() => state.orders.flatMap((order: Order) => order.assignments.filter(a => a.status === 'serving' && a.startedAt).map(a => {
  const item = order.items.find(i => i.id === a.itemId);
  const end = new Date(a.startedAt!).getTime() + ((item?.hours || 0) * 60 + (a.freeMinutes || 0)) * 60000;
  return { order, assignment: a, remaining: Math.ceil((end - now.value) / 60000) };
})).filter(r => r.remaining <= 10).sort((a, b) => a.remaining - b.remaining).slice(0, 5));
const recentEvents = computed(() => state.audit.slice(0, 5));
const serviceLabel = (order: Order) => {
  if (order.status === 'cancelled') return '已取消';
  if (order.status === 'draft') return '待客户确认';
  if (order.status === 'confirmed') return '待结清';
  const assignments = order.assignments.filter(a => !['replaced', 'cancelled'].includes(a.status));
  if (assignments.length && assignments.every(a => a.status === 'completed') && assignments.length >= order.items.length) return '已完成';
  if (assignments.some(a => a.status === 'serving')) return '服务中';
  if (!assignments.length) return '待派单';
  if (assignments.length < order.items.length) return '部分派单';
  return '待服务';
};
const reload = async () => { loading.value = true; try { await refresh(); } catch (e) { notifyError(e); } finally { loading.value = false; } };
const cards = computed(() => [
  { title: '客户档案', value: state.dashboard?.customers || 0, sub: '会员与消费记录统一管理', icon: User, color: 'violet', path: '/customers' },
  { title: '待确认 / 待收款', value: state.dashboard?.pendingPayment || 0, sub: '客户确认后再登记结清', icon: Tickets, color: 'amber', path: '/orders?filter=unpaid' },
  { title: '待派单', value: state.dashboard?.pendingDispatch || 0, sub: '已结清，等待安排成员', icon: Headset, color: 'blue', path: '/orders?filter=dispatch' },
  { title: '服务中', value: state.dashboard?.serving || 0, sub: '关注结束提醒与服务进度', icon: Clock, color: 'green', path: '/orders?filter=serving' }
]);
</script>

<template>
  <div class="dashboard">
    <div class="page-head">
      <div><h1 class="page-title">工作台</h1><p class="page-subtitle">每一份安排，都清楚有序。</p></div>
      <div class="head-actions"><el-button :icon="Refresh" :loading="loading" @click="reload">刷新</el-button><el-button type="primary" :icon="Plus" @click="router.push('/quotes')">新建报价</el-button></div>
    </div>
    <section class="welcome">
      <div class="welcome-main"><span class="welcome-eyebrow">BATTY CLUB · 贝蒂电竞</span><h2>{{ greeting }}，{{ state.user?.name || '伙伴' }} <span>✦</span></h2><p>今天已新增 <strong>{{ todayOrders.length }}</strong> 笔订单。把报价、收款记录和派单安排好，开始今天的工作吧。</p><div class="welcome-date">{{ dateText }} <span>{{ state.user?.role === 'admin' ? '管理员工作空间' : '客服工作空间' }}</span></div></div>
      <div class="welcome-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-card"><el-icon :size="30"><Headset /></el-icon><span>PLAY TOGETHER</span><b>好服务，有陪伴</b><div class="art-dots"><i></i><i></i><i></i><i></i></div></div><span class="spark spark-one">✦</span><span class="spark spark-two">✧</span></div>
    </section>
    <div class="stats-grid">
      <button v-for="card in cards" :key="card.title" class="stat-card" @click="router.push(card.path)"><div class="stat-top"><span>{{ card.title }}</span><div class="stat-icon" :class="card.color"><el-icon :size="20"><component :is="card.icon" /></el-icon></div></div><strong>{{ card.value }}</strong><p>{{ card.sub }}</p></button>
    </div>
    <div v-if="reminders.length" class="reminder-panel"><el-icon :size="20"><Clock /></el-icon><div><strong>服务结束提醒</strong><span v-for="r in reminders" :key="r.assignment.id" @click="router.push('/orders?orderId=' + r.order.id)">{{ r.order.customerName }} · {{ r.assignment.playerName }}：{{ r.remaining > 0 ? `还剩 ${r.remaining} 分钟` : `已到计划结束时间${r.remaining < 0 ? `（超过 ${Math.abs(r.remaining)} 分钟）` : ''}` }}</span></div><span class="reminder-note">请联系客户确认是否续单；超时不会自动扣费。</span></div>
    <div class="main-grid">
      <section class="panel trend-panel">
        <div class="section-head"><div><h3>订单趋势</h3><p>最近 7 天的已结清订单金额</p></div><span class="soft-pill">近 7 日</span></div>
        <div class="chart" v-if="daily.length"><div v-for="d in daily" :key="d.date" class="bar-column"><span class="bar-label">{{ d.amountCents ? money(d.amountCents) : '—' }}</span><div class="bar-track"><div class="bar-fill" :style="{ height: `${Math.max(3, d.amountCents / maxDaily * 100)}%` }"><span>{{ d.count }} 单</span></div></div><span class="bar-date">{{ d.date.slice(5).replace('-', '/') }}</span></div></div>
        <el-empty v-else description="暂无订单数据，先创建第一份报价" :image-size="90" />
        <div class="trend-foot"><span><i></i>订单金额</span><span>按收款时间统计；退款在账目中另列</span></div>
      </section>
      <section class="panel finance-panel"><div class="section-head"><div><h3>账目概览</h3><p>充值与消费分别统计</p></div><el-icon class="finance-icon" :size="22"><Wallet /></el-icon></div><div class="finance-primary"><span>外部净收款</span><strong>{{ money(state.dashboard?.cashReceivedCents || 0) }}</strong><small>充值到账 + 订单直付 − 外部退款</small></div><div class="finance-row"><span><i class="dot violet-dot"></i>充值到账</span><b>{{ money(state.dashboard?.rechargeCents || 0) }}</b></div><div class="finance-row"><span><i class="dot blue-dot"></i>订单外部付款</span><b>{{ money(state.dashboard?.externalOrderCents || 0) }}</b></div><div class="finance-row"><span><i class="dot green-dot"></i>余额净消费</span><b>{{ money(state.dashboard?.walletConsumedCents || 0) }}</b></div><div class="finance-row"><span><i class="dot amber-dot"></i>客户余额总额</span><b>{{ money(state.dashboard?.walletLiabilityCents || 0) }}</b></div><button class="text-link" @click="router.push('/reports')">查看统计与导出 <el-icon><ArrowRight /></el-icon></button></section>
    </div>
    <div class="bottom-grid">
      <section class="panel orders-panel"><div class="section-head"><div><h3>我跟进的订单 <span class="count-badge">{{ myOrders.length }}</span></h3><p>客户确认、收款与派单的下一步</p></div><button class="text-link" @click="router.push('/orders')">全部订单 <el-icon><ArrowRight /></el-icon></button></div><el-table :data="myOrders" empty-text="暂无跟进订单，可以先创建报价" @row-click="(row: Order) => router.push('/orders?orderId=' + row.id)" class="clickable-table"><el-table-column prop="code" label="订单编号" min-width="160" /><el-table-column prop="customerName" label="客户" min-width="90" /><el-table-column label="金额" min-width="100"><template #default="{ row }"><span class="amount-text">{{ money(row.totalCents) }}</span></template></el-table-column><el-table-column label="进度" min-width="100"><template #default="{ row }"><el-tag size="small" :type="serviceLabel(row) === '已完成' ? 'success' : serviceLabel(row) === '待派单' ? 'warning' : 'info'" effect="light">{{ serviceLabel(row) }}</el-tag></template></el-table-column></el-table></section>
      <section class="panel activity-panel"><div class="section-head"><div><h3>最近动态</h3><p>关键操作都有迹可循</p></div><el-icon :size="20" class="muted"><TrendCharts /></el-icon></div><div v-if="recentEvents.length" class="activity-list"><div v-for="event in recentEvents" :key="event.id" class="activity-item"><i class="activity-dot"></i><div><p><strong>{{ event.actorName }}</strong> {{ event.action }}</p><span>{{ event.targetName || event.targetType }}</span><small>{{ new Date(event.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</small></div></div></div><el-empty v-else description="暂无操作记录" :image-size="70" /></section>
    </div>
  </div>
</template>

<style scoped>
.head-actions{display:flex;gap:10px}.welcome{position:relative;overflow:hidden;display:flex;justify-content:space-between;background:linear-gradient(115deg,#eeeaff 0%,#f1eeff 55%,#e9e5ff 100%);border:1px solid #e9e3ff;border-radius:16px;padding:29px 34px;margin-bottom:24px;min-height:188px}.welcome-eyebrow{font-size:11px;letter-spacing:2px;font-weight:700;color:#7a6ac0}.welcome h2{font-size:26px;letter-spacing:-.6px;color:#302650;margin:12px 0}.welcome h2 span{color:#aa92ed;margin-left:5px}.welcome p{font-size:13px;color:#776d91;line-height:1.9;margin:0;max-width:650px}.welcome p strong{color:#6452c9}.welcome-date{display:flex;align-items:center;gap:15px;color:#8d82a5;font-size:11px;margin-top:18px}.welcome-date span{border-left:1px solid #cfc5e9;padding-left:15px}.welcome-art{width:260px;position:relative;flex-shrink:0}.art-card{position:absolute;right:37px;top:0;transform:rotate(-7deg);width:174px;height:149px;background:rgba(255,255,255,.72);border:2px solid white;box-shadow:0 12px 34px #8670bf1c;border-radius:22px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#7860c7}.art-card>span{font-size:8px;letter-spacing:2px;margin-top:10px}.art-card>b{font-size:13px;margin-top:5px;letter-spacing:2px}.art-dots{display:flex;gap:4px;margin-top:12px}.art-dots i{width:4px;height:4px;border-radius:50%;background:#c8baed}.orbit{position:absolute;right:-10px;top:8px;width:230px;height:130px;border:1px solid #c9b9ed90;border-radius:50%;transform:rotate(-28deg)}.orbit-two{transform:rotate(34deg)}.spark{position:absolute;color:#a792d9}.spark-one{right:18px;top:5px;font-size:30px}.spark-two{left:15px;bottom:10px;font-size:27px}.stats-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin-bottom:24px}.stat-card{text-align:left;background:white;border:1px solid #eaeaf1;border-radius:14px;padding:19px 21px;cursor:pointer;transition:transform .15s,box-shadow .15s;color:#28283e}.stat-card:hover{transform:translateY(-2px);box-shadow:0 8px 20px #28283e08}.stat-top{display:flex;justify-content:space-between;align-items:center;color:#77768a;font-size:12px}.stat-icon{width:35px;height:35px;border-radius:10px;display:flex;align-items:center;justify-content:center}.violet{color:#7560d7;background:#eeeafd}.amber{color:#d6a34f;background:#fff4df}.blue{color:#5c92cf;background:#eaf3ff}.green{color:#46a88c;background:#e5f6ef}.stat-card>strong{display:block;font-size:29px;font-weight:650;line-height:1.4;margin-top:3px;letter-spacing:-1px}.stat-card>p{font-size:11px;color:#a1a0b1;margin:8px 0 0}.main-grid{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(300px,1fr);gap:22px;margin-bottom:22px}.section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:16px}.section-head h3{font-size:14px;font-weight:650;margin:0;color:#343348;display:flex;align-items:center;gap:8px}.section-head p{font-size:11px;color:#a09dac;margin:7px 0 0}.soft-pill{padding:5px 10px;border-radius:6px;background:#f5f3fb;color:#92879e;font-size:10px;white-space:nowrap}.trend-panel,.finance-panel,.orders-panel,.activity-panel{padding:22px 24px}.chart{height:220px;display:flex;gap:18px;align-items:flex-end;padding:10px 10px 0;border-bottom:1px solid #f0eef5;background:repeating-linear-gradient(to top,transparent,transparent 49px,#f7f6fa 50px)}.bar-column{height:100%;flex:1;display:flex;align-items:center;flex-direction:column;justify-content:flex-end;min-width:0}.bar-label{font-size:10px;color:#9e96af;margin-bottom:8px;white-space:nowrap}.bar-track{width:100%;max-width:42px;height:158px;display:flex;align-items:flex-end}.bar-fill{position:relative;background:linear-gradient(to top,#c9bdf3,#a899e7);width:100%;border-radius:6px 6px 0 0;min-height:4px;transition:height .3s}.bar-fill span{position:absolute;top:7px;left:0;right:0;color:white;font-size:9px;text-align:center;opacity:0}.bar-fill:hover{background:linear-gradient(to top,#8976d8,#7560cc)}.bar-fill:hover span{opacity:1}.bar-date{font-size:10px;color:#9b96a8;padding:11px 0}.trend-foot{display:flex;justify-content:space-between;font-size:10px;color:#a49cae;margin-top:15px}.trend-foot span:first-child{display:flex;align-items:center;gap:6px}.trend-foot i{display:inline-block;width:7px;height:7px;background:#ad9ce8;border-radius:2px}.finance-icon{color:#ad9ce1}.finance-primary{background:#f7f5ff;border-radius:10px;padding:16px 17px;margin-bottom:9px;display:flex;flex-direction:column}.finance-primary>span{font-size:11px;color:#92879f}.finance-primary strong{font-size:24px;color:#6453a9;font-weight:650;margin:7px 0;letter-spacing:-.5px}.finance-primary small{font-size:9px;color:#aaa0b5}.finance-row{display:flex;justify-content:space-between;align-items:center;padding:10px 1px;font-size:11px;color:#92909f}.finance-row>span{display:flex;align-items:center;gap:8px}.finance-row b{font-size:12px;color:#686273;font-weight:550}.dot{width:6px;height:6px;border-radius:50%}.violet-dot{background:#ab96df}.blue-dot{background:#94b5e0}.green-dot{background:#90c5af}.amber-dot{background:#dfc28c}.text-link{border:0;background:none;color:#8c79c6;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:0;font-size:11px}.finance-panel>.text-link{margin-top:10px}.bottom-grid{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(300px,1fr);gap:22px}.count-badge{padding:2px 6px;background:#f0edf9;border-radius:5px;font-size:10px;color:#9384bb}.amount-text{font-weight:600;color:#665c81}.clickable-table{cursor:pointer}.activity-list{padding-top:3px}.activity-item{display:flex;gap:12px;position:relative;padding-bottom:18px}.activity-item:not(:last-child):before{content:'';position:absolute;left:3px;top:10px;bottom:0;width:1px;background:#eeeaf5}.activity-dot{width:7px;height:7px;flex-shrink:0;border-radius:50%;background:#c6b8e9;margin-top:5px;z-index:1}.activity-item>div{min-width:0;flex:1}.activity-item p{font-size:11px;color:#8e889e;margin:0;line-height:1.7}.activity-item p strong{color:#5f566f;font-weight:550}.activity-item span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#a49cad;font-size:10px;margin-top:3px}.activity-item small{font-size:9px;color:#b7afc0;display:block;margin-top:4px}.reminder-panel{display:flex;align-items:flex-start;gap:12px;background:#fff9e9;border:1px solid #f4e4b5;color:#b08b3a;border-radius:12px;padding:14px 18px;margin-bottom:22px}.reminder-panel>div{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;flex:1}.reminder-panel>div>span{cursor:pointer}.reminder-note{font-size:10px;max-width:230px;line-height:1.6}.reminder-panel>div>strong{width:100%}@media(max-width:1100px){.main-grid,.bottom-grid{grid-template-columns:1fr}.stats-grid{gap:12px}.welcome-art{width:200px}.welcome{padding:25px}.stat-card{padding:16px}.stat-card>p{font-size:10px}}@media(max-width:700px){.stats-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.welcome-art{display:none}.welcome h2{font-size:22px}.welcome-date{flex-wrap:wrap;gap:6px}.head-actions{gap:4px}.head-actions .el-button{padding:8px}.chart{gap:8px}.trend-panel,.finance-panel,.orders-panel,.activity-panel{padding:18px}.reminder-panel{flex-wrap:wrap}.reminder-note{max-width:none}.bar-label{font-size:8px}.trend-foot{font-size:9px}}
</style>
