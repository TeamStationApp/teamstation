import type { Kysely } from 'kysely'

import { drainDirty } from '../server/chat/reconciler'
import type { Database } from '../server/db/database'
import { chatRoutes } from '../server/routes/chat'
import { chatEpochRoutes } from '../server/routes/chatEpochs'
import { chatKeyRoutes } from '../server/routes/chatKeys'
import { chatMessageRoutes } from '../server/routes/chatMessages'
import type { MountExtra } from './accountHarness'

/**
 * Chat, as the server serves it, for the display names pass: its routes,
 * mounted on the group fixture, and the team, season and league chats the
 * server's reconciler would make. Its own file, which the browser pass
 * requires: chat's server code is Node's, and the pass is type-checked with
 * the app's DOM library.
 */
export const mountChat: MountExtra = (app, { db, media }) => {
  app.use('/api/v1', chatRoutes(db, media))
  app.use('/api/v1', chatKeyRoutes(db))
  app.use('/api/v1', chatEpochRoutes(db))
  app.use('/api/v1', chatMessageRoutes(db, media))
}

/** Makes every chat the fixture's groups and people call for. */
export async function reconcileChats(db: Kysely<Database>): Promise<void> {
  await drainDirty(db, new Date())
}
