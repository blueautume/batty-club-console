export type LeaveReason = 'navigation' | 'logout';
type EditorLeaveGuard = (reason: LeaveReason) => Promise<boolean>;
let current: EditorLeaveGuard | null = null;
export function registerEditorLeaveGuard(guard: EditorLeaveGuard): () => void {
  current = guard;
  return () => { if (current === guard) current = null; };
}
export async function requestEditorLeave(reason: LeaveReason = 'navigation'): Promise<boolean> {
  return current ? current(reason) : true;
}
