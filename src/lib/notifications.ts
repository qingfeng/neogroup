import type { Database } from '../db'
import { notifications } from '../db/schema'
import { generateId } from './utils'

export async function createNotification(
  db: Database,
  data: {
    userId: string
    actorId: string
    type: string
    topicId?: string
    commentId?: string
  }
): Promise<void> {
  if (data.userId === data.actorId) return
  await db.insert(notifications).values({
    id: generateId(),
    userId: data.userId,
    actorId: data.actorId,
    type: data.type,
    topicId: data.topicId || null,
    commentId: data.commentId || null,
    createdAt: new Date(),
  })
}
