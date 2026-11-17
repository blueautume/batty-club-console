export interface PendingWorkflowSubmission {
  path: string;
  body: string;
  createdAt: string;
  requestId?: string;
}
type RecoverySlot = 'action' | 'completion';
const key = (userId: string, slot: RecoverySlot) => `batty:workflow:${slot}:${userId}`;
export function readWorkflowSubmission(userId: string, slot: RecoverySlot): PendingWorkflowSubmission | null {
  try {
    const raw = sessionStorage.getItem(key(userId, slot));
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingWorkflowSubmission;
    if (!value || typeof value.path !== 'string' || !value.path.startsWith('/api/workflow/') || typeof value.body !== 'string' || typeof value.createdAt !== 'string') return null;
    const body = JSON.parse(value.body);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return value;
  } catch { return null; }
}
export function saveWorkflowSubmission(userId: string, slot: RecoverySlot, value: PendingWorkflowSubmission): void {
  try { sessionStorage.setItem(key(userId, slot), JSON.stringify(value)); } catch { /* The mounted form still retains the exact request when browser storage is unavailable. */ }
}
export function clearWorkflowSubmission(userId: string, slot: RecoverySlot): void {
  try { sessionStorage.removeItem(key(userId, slot)); } catch { /* An inaccessible browser storage does not change the recorded business result. */ }
}
