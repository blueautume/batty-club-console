export type LeaveReason = 'navigation' | 'logout';
type EditorLeaveGuard = (reason: LeaveReason) => Promise<boolean>;
const guards = new Set<EditorLeaveGuard>();
export function registerEditorLeaveGuard(guard: EditorLeaveGuard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}
export async function requestEditorLeave(reason: LeaveReason = 'navigation'): Promise<boolean> {
  for (const guard of [...guards]) if (!await guard(reason)) return false;
  return true;
}
