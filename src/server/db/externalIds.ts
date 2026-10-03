import type { Transaction } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database } from './database'

/** One id another system has for a row here. */
export interface ExternalIdKey {
  /** `^[a-z][a-zA-Z0-9]{0,31}$`, which the table's check holds too. */
  system: string
  kind: string
  id: string
}

/**
 * The advisory-lock key of an external id, the same whatever it is to be
 * on, so a team and a person claiming one id at once queue rather than both
 * finding it free.
 */
export function externalIdLockKey(externalId: ExternalIdKey): string {
  return `extid:${externalId.system}:${externalId.kind}:${externalId.id}`
}

/**
 * Records an external id on a row, unless that system and kind hold the id
 * already. True when this call wrote it.
 */
export async function recordExternalId(
  trx: Transaction<Database>,
  entityType: string,
  entityId: string,
  externalId: ExternalIdKey
): Promise<boolean> {
  const inserted = await trx
    .insertInto('external_ids')
    .values({
      id: makeId('externalId'),
      entity_type: entityType,
      entity_id: entityId,
      system: externalId.system,
      kind: externalId.kind,
      external_id: externalId.id
    })
    .onConflict(oc => oc.columns(['system', 'kind', 'external_id']).doNothing())
    .executeTakeFirst()
  return Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0
}
