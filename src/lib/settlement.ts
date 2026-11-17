import type { SettlementAdjustment } from '../../shared/types';

export function settlementDifference(orderId: string, assignmentId: string, adjustments: SettlementAdjustment[] | undefined): number {
  return (adjustments || []).filter(entry => entry.orderId === orderId && entry.assignmentId === assignmentId).reduce((sum, entry) => sum + entry.amountCents, 0);
}
