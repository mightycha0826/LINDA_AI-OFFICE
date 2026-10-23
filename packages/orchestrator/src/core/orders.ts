// CEO 지시 등록. 같은 Discord 메시지로는 지시가 하나만 생긴다 (4장).
import { eq } from 'drizzle-orm';
import { emit, inTx, nextSeqId, nowIso, type Ctx } from '../context.ts';
import { orders } from '../db/schema.ts';

export type OrderRow = typeof orders.$inferSelect;

/** projectId: 프로젝트 #작업 채널에서 온 지시면 그 프로젝트로 고정한다 (9장, 6장 PM) */
export function registerOrder(c: Ctx, input: { discordMessageId: string; rawText: string; projectId?: string }): { order: OrderRow; created: boolean } {
  return inTx(c, (t) => {
    const existing = t.db.select().from(orders).where(eq(orders.discordMessageId, input.discordMessageId)).get();
    if (existing) return { order: existing, created: false };
    const order = t.db
      .insert(orders)
      .values({ id: nextSeqId(t, 'orders', 'O'), discordMessageId: input.discordMessageId, rawText: input.rawText, projectId: input.projectId ?? null, createdAt: nowIso(t) })
      .returning()
      .get();
    emit(t, 'order.created', { orderId: order.id, discordMessageId: order.discordMessageId });
    return { order, created: true };
  });
}
