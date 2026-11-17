import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './styles/pure-reset.css';
import './styles/app.css';
import App from './App.vue';
import { authenticated, state } from './lib/store';
import { isAdminRole } from '../shared/roles';
const router=createRouter({history:createWebHistory(),routes:[
  {path:'/',redirect:'/dashboard'},
  {path:'/dashboard',component:()=>import('./views/DashboardView.vue')},
  {path:'/customers',component:()=>import('./views/CustomersView.vue')},
  {path:'/players',component:()=>import('./views/PlayersView.vue')},
  {path:'/quotes',component:()=>import('./views/QuotesView.vue')},
  {path:'/quote-drafts',component:()=>import('./views/QuoteDraftsView.vue')},
  {path:'/orders',component:()=>import('./views/OrdersView.vue')},
  {path:'/approvals',component:()=>import('./views/ApprovalsView.vue')},
  {path:'/reports',component:()=>import('./views/ReportsView.vue')},
  {path:'/management',component:()=>import('./views/ManagementView.vue')},
  {path:'/settings',component:()=>import('./views/SettingsView.vue')},
  {path:'/:pathMatch(.*)*',redirect:'/dashboard'}
]});
router.beforeEach(to => {
  if (!authenticated.value) return;
  if (state.user.role === 'shareholder' && to.path !== '/reports') return '/reports';
  if (['/management', '/settings'].includes(to.path) && !isAdminRole(state.user.role)) return '/dashboard';
});
createApp(App).use(router).use(ElementPlus,{locale:zhCn}).mount('#app');
