import { createHash } from 'node:crypto'

import type { Kysely } from 'kysely'

import { conflict, forbidden } from '../../common/errors'
import type { CreateGroup } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import { catalogPicture } from '../../common/pictureCatalog'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { imageUrl, PROFILE_SIZE } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { groupScopeIds, noteScopeChange } from '../socket/syncRevision'
import { storeGroupPhoto } from './groupPhoto'
import { currentActor, requireGroupAdmin } from './rights'

export interface CreatedGroup {
  id: string
  kind: 'league' | 'season' | 'team'
  name: string
  imageUrl: string | null
}

export async function createGroup(
  db: Kysely<Database>,
  actor: Actor,
  body: CreateGroup,
  media: MediaContext
): Promise<CreatedGroup> {
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `creation:${actor.userId}:${body.idempotencyKey}`
    ])
    const fresh = await currentActor(trx, actor)
    const held = await trx
      .selectFrom('creation_idempotency')
      .select(['body_hash', 'response'])
      .where('user_id', '=', fresh.userId)
      .where('key', '=', body.idempotencyKey)
      .executeTakeFirst()
    if (held != null) {
      if (held.body_hash !== hash)
        throw conflict(
          'This retry key already belongs to different group details'
        )
      return held.response as CreatedGroup
    }
    const user = await trx
      .selectFrom('users')
      .select('onboarding_step')
      .where('id', '=', fresh.userId)
      .executeTakeFirstOrThrow()
    if (user.onboarding_step !== 'complete')
      throw forbidden('Complete your name and photo onboarding first')
    if (body.parent != null) await requireGroupAdmin(trx, fresh, body.parent)
    if (body.custodian != null) {
      await requireGroupAdmin(trx, fresh, body.custodian)
      if (
        body.custodian.kind === 'team' &&
        (
          await trx
            .selectFrom('teams')
            .select('kind')
            .where('id', '=', body.custodian.id)
            .executeTakeFirstOrThrow()
        ).kind !== 'full'
      )
        throw forbidden('Choose a full team as custodian')
    }
    const id = makeId(body.kind)
    let leagueId: string | null = null
    if (body.parent?.kind === 'league') leagueId = body.parent.id
    if (body.parent?.kind === 'season')
      leagueId = (
        await trx
          .selectFrom('seasons')
          .select('league_id')
          .where('id', '=', body.parent.id)
          .executeTakeFirstOrThrow()
      ).league_id
    const picture =
      body.picture?.catalogId == null
        ? null
        : catalogPicture(body.picture.catalogId)!
    let prefix = picture?.prefix ?? null
    if (body.kind === 'league')
      await trx
        .insertInto('leagues')
        .values({
          id,
          name: body.name,
          locality: body.locality,
          picture_catalog_id: picture?.id ?? null,
          logo_path: prefix,
          logo_sha256: picture?.sha256 ?? null,
          logo_source: picture == null ? null : 'upload'
        })
        .execute()
    else if (body.kind === 'season')
      await trx
        .insertInto('seasons')
        .values({
          id,
          name: body.name,
          league_id: leagueId,
          year: Number(body.startsOn!.slice(0, 4)),
          starts_on: body.startsOn!,
          ends_on: body.endsOn!,
          timezone: body.timezone,
          picture_catalog_id: picture?.id ?? null,
          logo_path: prefix,
          logo_sha256: picture?.sha256 ?? null,
          logo_source: picture == null ? null : 'upload'
        })
        .execute()
    else {
      await trx
        .insertInto('teams')
        .values({
          id,
          name: body.name,
          league_id: leagueId,
          locality: body.locality ?? null,
          picture_catalog_id: picture?.id ?? null,
          logo_path: prefix,
          logo_sha256: picture?.sha256 ?? null,
          logo_source: picture == null ? null : 'upload',
          created_from: 'manual',
          kind: body.external === true ? 'external' : 'full',
          custodian_type: body.custodian?.kind ?? null,
          custodian_id: body.custodian?.id ?? null
        })
        .execute()
      if (body.parent?.kind === 'season')
        await trx
          .insertInto('season_team_parents')
          .values({ team_id: id, season_id: body.parent.id })
          .execute()
    }
    if (body.external !== true)
      await trx
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: fresh.userId,
          scope_type: body.kind,
          scope_id: id,
          role: 'admin',
          granted_by: fresh.userId
        })
        .execute()
    if (body.picture?.image != null)
      prefix = await storeGroupPhoto(
        trx,
        media,
        { kind: body.kind, id },
        body.picture.image
      )
    // The creator's home lists what they made.
    noteScopeChange(trx, {
      userId: fresh.userId,
      ...groupScopeIds(body.kind, id)
    })
    const result: CreatedGroup = {
      id,
      kind: body.kind,
      name: body.name,
      imageUrl: imageUrl(media.space, prefix, PROFILE_SIZE)
    }
    await trx
      .insertInto('creation_idempotency')
      .values({
        user_id: fresh.userId,
        key: body.idempotencyKey,
        body_hash: hash,
        response: result
      })
      .execute()
    return result
  })
}
