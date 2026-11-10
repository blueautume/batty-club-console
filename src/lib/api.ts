import { ElMessage, ElMessageBox } from 'element-plus';
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = 'ApiError'; this.status = status; }
}
let authGeneration = 0;
export function invalidateApiSession(): void { authGeneration++; }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const requestedSession = authGeneration;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { const data = await response.json(); message = data.message || data.error || message; } catch {}
    if (response.status === 401 && requestedSession === authGeneration) window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return await response.json();
}
export function money(cents: number | undefined | null): string { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format((cents || 0) / 100); }
export function dateTime(value?: string): string { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'; }
export function notifyError(error: unknown): void { ElMessage.error(error instanceof Error ? error.message : String(error)); }
export async function confirmAction(message: string): Promise<boolean> { try { await ElMessageBox.confirm(message, '请确认操作', { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' }); return true; } catch { return false; } }
export async function exportFile(type: string, format = 'xlsx', params: Record<string,string> = {}): Promise<void> {
  const response = await fetch(`/api/export/${type}?${new URLSearchParams({ format, ...params })}`, { credentials: 'same-origin' });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || '导出失败'); }
  const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a');link.href=url;link.download=`贝蒂-${type}-${new Date().toISOString().slice(0,10)}.${format}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function copyText(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); } catch { const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw new Error('复制失败，请在确认单中手动选择复制'); }
}
