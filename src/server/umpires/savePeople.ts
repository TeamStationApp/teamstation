import type { Transaction } from 'kysely'

import { badRequest, conflict } from '../../common/errors'
import {
  type UmpireEdit,
  type UmpireState,
  umpireStateKey
} from '../../common/umpireEdits'
import { onePerson } from '../admin/people'
import type { Database } from '../db/database'
import { certify, grant, levels, people, revoke } from './admin'
import { types } from './types'

function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    throw badRequest('Supply umpire changes')
  return value as Record<string, unknown>
}
function state(value: unknown): UmpireState {
  if (value === null) return null
  const { certifications } = object(value)
  if (!Array.isArray(certifications) || certifications.length > 10000)
    throw badRequest('Supply up to 10000 certifications per umpire')
  const ids = new Set<string>()
  return {
    certifications: certifications.map(raw => {
      const c = object(raw)
      if (
        typeof c.levelId !== 'string' ||
        c.levelId === '' ||
        typeof c.typeId !== 'string' ||
        c.typeId === '' ||
        typeof c.enabled !== 'boolean' ||
        ids.has(JSON.stringify([c.levelId, c.typeId]))
      )
        throw badRequest('Choose unique levels and boolean certifications')
      ids.add(JSON.stringify([c.levelId, c.typeId]))
      return { levelId: c.levelId, typeId: c.typeId, enabled: c.enabled }
    })
  }
}
function edits(body: unknown): UmpireEdit[] {
  const { changes } = object(body)
  if (!Array.isArray(changes) || changes.length > 500)
    throw badRequest('Supply up to 500 umpire changes')
  const ids = new Set<string>()
  return changes.map(raw => {
    const edit = object(raw)
    if (
      typeof edit.userId !== 'string' ||
      edit.userId === '' ||
      ids.has(edit.userId)
    )
      throw badRequest('Choose each umpire once')
    ids.add(edit.userId)
    return {
      userId: edit.userId,
      before: state(edit.before),
      after: state(edit.after)
    }
  })
}
/** Called inside the league administration transaction and identity locks. */
export async function savePeople(
  db: Transaction<Database>,
  league: string,
  actor: string,
  body: unknown
): Promise<void> {
  const changes = edits(body)
  const known = new Set((await levels(db, league)).map(l => l.id))
  const knownTypes = new Set((await types(db, league)).map(t => t.id))
  const current = new Map((await people(db, league)).map(p => [p.id, p]))
  const pending: UmpireEdit[] = []
  for (const edit of changes) {
    const person = await onePerson(db, edit.userId)
    if (person.userId !== edit.userId)
      throw conflict('An account changed. Reload saved settings and try again.')
    for (const s of [edit.before, edit.after])
      for (const c of s?.certifications ?? [])
        if (!known.has(c.levelId) || !knownTypes.has(c.typeId))
          throw badRequest('Choose a level and type in this league')
    const held = current.get(edit.userId) ?? null
    if (umpireStateKey(held) === umpireStateKey(edit.after)) continue
    if (umpireStateKey(held) !== umpireStateKey(edit.before))
      throw conflict(
        'Umpire settings changed elsewhere. Reload saved settings and try again.'
      )
    pending.push(edit)
  }
  for (const edit of pending) {
    if (edit.after == null) {
      await revoke(db, league, edit.userId)
      continue
    }
    await grant(db, league, edit.userId, actor)
    // Also clear dormant permissions omitted from the requested final state.
    const held = (await people(db, league)).find(p => p.id === edit.userId)
    const key = (c: { levelId: string; typeId: string }): string =>
      JSON.stringify([c.levelId, c.typeId])
    const wanted = new Map(edit.after.certifications.map(c => [key(c), c]))
    const previous = new Map((held?.certifications ?? []).map(c => [key(c), c]))
    for (const pair of new Set([...previous.keys(), ...wanted.keys()])) {
      const old = previous.get(pair)
      const next = wanted.get(pair) ?? { ...old!, enabled: false }
      if ((old?.enabled ?? false) !== next.enabled)
        await certify(db, league, edit.userId, next)
    }
  }
}
