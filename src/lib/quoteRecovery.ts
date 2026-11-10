import type { QuoteDraft, QuoteDraftPayload } from '../../shared/types.ts';

export interface QuoteRecoverySource {
  serverDraftId?: string;
  serverVersion?: number;
  conflicted?: boolean;
  pendingCreation?: boolean;
}
export interface QuoteRecovery extends QuoteRecoverySource {
  id: string;
  userId: string;
  payload: QuoteDraftPayload;
  title: string;
  updatedAt: string;
}
export interface RecoveryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const prefix = 'batty:quote-recovery:v1:';
const accountPrefix = (userId: string) => `${prefix}${encodeURIComponent(userId)}:`;
const key = (userId: string, id: string) => `${accountPrefix(userId)}${encodeURIComponent(id)}`;
function browserStorage(): RecoveryStorage | undefined {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; } catch { return undefined; }
}
export function writeQuoteRecovery(recovery: QuoteRecovery, storage: RecoveryStorage | undefined = browserStorage()): boolean {
  if (!storage || !recovery.userId || !recovery.id) return false;
  try { storage.setItem(key(recovery.userId, recovery.id), JSON.stringify(recovery)); return true; } catch { return false; }
}
/** A restored edit still belongs to the version it was made against, not the latest fetched draft. */
export function restoredQuoteRecoverySource(recovery: QuoteRecoverySource, draft: Pick<QuoteDraft, 'id' | 'version'> | null): QuoteRecoverySource {
  return {
    serverDraftId: recovery.serverDraftId,
    serverVersion: recovery.serverVersion,
    pendingCreation: recovery.pendingCreation,
    conflicted: !!recovery.conflicted || !!recovery.serverDraftId && (!draft || draft.id !== recovery.serverDraftId || draft.version !== recovery.serverVersion)
  };
}
/** Keep recovery in sync with the visible edit, including undo back to the saved version. */
export function syncQuoteRecovery(recovery: QuoteRecovery, baselineFingerprint: string, storage: RecoveryStorage | undefined = browserStorage()): boolean {
  if (recovery.conflicted || recovery.pendingCreation || JSON.stringify(recovery.payload) !== baselineFingerprint) return writeQuoteRecovery(recovery, storage);
  if (!storage) return false;
  try { storage.removeItem(key(recovery.userId, recovery.id)); return true; } catch { return false; }
}
export function readQuoteRecovery(userId: string, id: string, storage: RecoveryStorage | undefined = browserStorage()): QuoteRecovery | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(key(userId, id));
    if (!text || text.length > 600_000) return null;
    const value = JSON.parse(text) as QuoteRecovery;
    if (value.userId !== userId || value.id !== id || !value.payload || !Array.isArray(value.payload.items) || typeof value.updatedAt !== 'string') return null;
    return value;
  } catch { return null; }
}
export function listQuoteRecoveries(userId: string, storage: RecoveryStorage | undefined = browserStorage()): QuoteRecovery[] {
  if (!storage || !userId) return [];
  const records: QuoteRecovery[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const itemKey = storage.key(i);
      if (!itemKey?.startsWith(accountPrefix(userId))) continue;
      const record = readQuoteRecovery(userId, decodeURIComponent(itemKey.slice(accountPrefix(userId).length)), storage);
      if (record) records.push(record);
    }
  } catch { return records; }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function removeQuoteRecovery(userId: string, id: string, storage: RecoveryStorage | undefined = browserStorage()): void {
  try { storage?.removeItem(key(userId, id)); } catch { /* Keep the editor usable when storage is unavailable. */ }
}
export function getQuoteRecoveryTabId(): string {
  try {
    let value = sessionStorage.getItem('batty:quote-recovery-tab');
    if (!value) { value = crypto.randomUUID(); sessionStorage.setItem('batty:quote-recovery-tab', value); }
    return value;
  } catch { return crypto.randomUUID(); }
}
export function setQuoteRecoveryTabId(id: string): void {
  try { sessionStorage.setItem('batty:quote-recovery-tab', id); } catch { /* The recovery itself still lives in localStorage. */ }
}
export function startQuoteRecovery(): string {
  const id = crypto.randomUUID();
  setQuoteRecoveryTabId(id);
  return id;
}
