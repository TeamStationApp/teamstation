import { isDeepStrictEqual } from 'node:util'

import { type Kysely, sql } from 'kysely'

import { badRequest, notFound } from '../../common/errors'
import {
  normalizeTag,
  type TagChoices,
  type TagDocument,
  TagIdentityRegistry,
  tagMetadata,
  tagTargets,
  withTargetTags
} from '../../common/eventTags'
import type { Database } from '../db/database'

/** Caller holds the game row lock, shared by scoring and tag writes. */
export async function reconcileEventTags(
  db: Kysely<Database>,
  gameId: string
): Promise<TagDocument[]> {
  const rows = await db
    .selectFrom('events')
    .select(['id', 'gumbo'])
    .where('gameId', '=', gameId)
    .orderBy('atBatIndex')
    .execute()
  const game = await db
    .selectFrom('games')
    .select('currentPlay')
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  const registry = new TagIdentityRegistry()
  const documents = rows.map(row => row.gumbo as TagDocument)
  const current = game.currentPlay as TagDocument | null
  for (const play of [...documents, current])
    if (play != null) {
      const metadata = tagMetadata(play)
      if (metadata.play != null || metadata.events.length > 0)
        registry.restore(play)
    }
  const decorated = documents.map(play =>
    play.about.atBatIndex === current?.about.atBatIndex
      ? { ...play, tagTargets: { version: 1, play: null, events: [] } }
      : registry.decorate(play, true)
  )
  const decoratedCurrent =
    current == null ? null : registry.decorate(current, false)
  const all = [...decorated, decoratedCurrent].filter(
    (play): play is TagDocument => play != null
  )
  const targets = all.flatMap(tagTargets)
  const ids = targets.map(target => target.id)
  if (new Set(ids).size !== ids.length)
    throw badRequest('Event tag identities must be unique within a game')
  let prune = db.deleteFrom('event_tags').where('game_id', '=', gameId)
  if (ids.length > 0) prune = prune.where('target_id', 'not in', ids)
  await prune.execute()
  const assignments = await db
    .selectFrom('event_tags')
    .select(['target_id', 'tag', 'at_bat_index', 'event_index'])
    .where('game_id', '=', gameId)
    .execute()
  const locations = new Map(targets.map(target => [target.id, target]))
  for (const assignment of assignments) {
    const target = locations.get(assignment.target_id)!
    if (
      assignment.at_bat_index !== target.atBatIndex ||
      assignment.event_index !== target.eventIndex
    )
      await db
        .updateTable('event_tags')
        .set({
          at_bat_index: target.atBatIndex,
          event_index: target.eventIndex
        })
        .where('game_id', '=', gameId)
        .where('target_id', '=', target.id)
        .execute()
  }
  const tags = new Map(assignments.map(row => [row.target_id, row.tag]))
  const result = decorated.map(play => withTargetTags(play, tags))
  for (let at = 0; at < rows.length; at++)
    if (!isDeepStrictEqual(rows[at].gumbo, result[at]))
      await db
        .updateTable('events')
        .set({ gumbo: result[at] })
        .where('id', '=', rows[at].id)
        .execute()
  if (decoratedCurrent != null) {
    const next = withTargetTags(decoratedCurrent, tags)
    if (!isDeepStrictEqual(current, next))
      await db
        .updateTable('games')
        .set({ currentPlay: next })
        .where('id', '=', gameId)
        .execute()
    result.push(next)
  }
  return result
}

export async function tagChoices(
  db: Kysely<Database>,
  userId: number,
  includeUnused = false
): Promise<TagChoices> {
  let popularQuery = db
    .selectFrom('event_tag_catalog as catalog')
    .leftJoin('event_tags as assignment', 'assignment.tag', 'catalog.tag')
    .select([
      'catalog.tag as tag',
      sql<number>`count(assignment.target_id)::integer`.as('count')
    ])
    .groupBy('catalog.tag')
    .orderBy('count', 'desc')
    .orderBy('catalog.tag')
  if (!includeUnused)
    popularQuery = popularQuery
      .having(sql<number>`count(assignment.target_id)`, '>', 0)
      .limit(30)
  const [recent, popular] = await Promise.all([
    db
      .selectFrom('user_tags')
      .select('tag')
      .where('user_id', '=', userId)
      .orderBy('last_used', 'desc')
      .orderBy('tag')
      .limit(10)
      .execute(),
    popularQuery.execute()
  ])
  return { recent: recent.map(row => row.tag), popular }
}

/** Serialized, idempotent assignment; labels in client Gumbo never authorize it. */
export async function writeEventTag(
  db: Kysely<Database>,
  gameId: string,
  targetId: string,
  userId: number,
  input: unknown
): Promise<{ targetId: string; tag: string | null; revision: string }> {
  let tag: string | null = null
  if (input !== null) {
    try {
      tag = normalizeTag(input)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'Invalid tag')
    }
  }
  const documents = await reconcileEventTags(db, gameId)
  const target = documents
    .flatMap(tagTargets)
    .find(item => item.id === targetId)
  if (target == null) throw notFound('This scoring event no longer exists')
  const previous = await db
    .selectFrom('event_tags')
    .select(['tag', 'assigned_by'])
    .where('game_id', '=', gameId)
    .where('target_id', '=', targetId)
    .executeTakeFirst()
  if (tag === null) {
    await db
      .deleteFrom('event_tags')
      .where('game_id', '=', gameId)
      .where('target_id', '=', targetId)
      .execute()
  } else if (previous?.tag !== tag || previous.assigned_by !== userId) {
    await db
      .insertInto('event_tag_catalog')
      .values({ tag })
      .onConflict(oc => oc.column('tag').doNothing())
      .execute()
    await db
      .insertInto('event_tags')
      .values({
        game_id: gameId,
        target_id: targetId,
        at_bat_index: target.atBatIndex,
        event_index: target.eventIndex,
        tag,
        assigned_by: userId
      })
      .onConflict(oc =>
        oc
          .columns(['game_id', 'target_id'])
          .doUpdateSet({ tag, assigned_by: userId })
      )
      .execute()
  }
  let revision: string
  if (tag !== null) {
    const saved = await db
      .insertInto('user_tags')
      .values({ user_id: userId, tag })
      .onConflict(oc =>
        oc.columns(['user_id', 'tag']).doUpdateSet({
          last_used: sql<number>`nextval('tag_use_sequence')`
        })
      )
      .returning(sql<string>`last_used::text`.as('revision'))
      .executeTakeFirstOrThrow()
    revision = saved.revision
  } else {
    const result = await sql<{
      revision: string
    }>`select nextval('tag_use_sequence')::text as revision`.execute(db)
    revision = result.rows[0].revision
  }
  await reconcileEventTags(db, gameId)
  return { targetId, tag, revision }
}
