import { asGumboId } from '../userId'
import { mapPlayers } from './actions'
import {
  asGameSetup,
  asLegacyGameSetup,
  type GameSetup,
  POSITIONS
} from './state'

/** Read old session identities without changing the stored play document. */
export function upgradeRecord(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw
  const record = raw as Record<string, unknown>
  if (record.version !== 1) return raw
  if (!Array.isArray(record.actions))
    throw new Error('Invalid historical actions')
  const initial = asLegacyGameSetup(record.setupBefore)
  const setups = [
    initial,
    ...record.actions.flatMap(action =>
      action != null && typeof action === 'object' && 'setup' in action
        ? [asLegacyGameSetup(action.setup)]
        : []
    )
  ]
  const identities = new Map<number, number>()
  for (const setup of setups) {
    for (const [key, value] of Object.entries(
      setup.identities.sessionToSource
    )) {
      const sid = Number(key)
      const id = asGumboId(value)
      if (
        !Number.isSafeInteger(sid) ||
        sid <= 0 ||
        String(sid) !== key ||
        (identities.has(sid) && identities.get(sid) !== id)
      )
        throw new Error('Ambiguous historical player identity')
      identities.set(sid, id)
    }
  }
  const idOf = (value: unknown): number => {
    if (typeof value !== 'number')
      throw new Error('Invalid historical player reference')
    const id = identities.get(value)
    if (id == null) throw new Error('Unmapped historical player')
    return id
  }
  const nullable = (value: number | null): number | null =>
    value == null ? null : idOf(value)
  const convert = (old: ReturnType<typeof asLegacyGameSetup>): GameSetup => {
    const players = Object.fromEntries(
      Object.entries(old.players).map(([sid, player]) => {
        const id = idOf(Number(sid))
        if (player.id !== Number(sid) || player.userId !== id)
          throw new Error('Conflicting historical player identity')
        return [id, { ...player, id, userId: id }]
      })
    )
    const side = (key: 'away' | 'home'): GameSetup['sides']['away'] => {
      const held = old.sides[key]
      return {
        ...held,
        players: held.players.map(idOf),
        battingOrder: held.battingOrder.map(idOf),
        defense: Object.fromEntries(
          POSITIONS.map(position => [
            position,
            nullable(held.defense[position])
          ])
        ) as GameSetup['sides']['away']['defense'],
        pitchCounts: Object.fromEntries(
          Object.entries(held.pitchCounts).map(([id, count]) => [
            idOf(Number(id)),
            count
          ])
        )
      }
    }
    return asGameSetup({
      players,
      sides: { away: side('away'), home: side('home') },
      tagOrder: [...identities.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, id]) => id)
    })
  }
  let nextId = initial.identities.nextId
  const actions = record.actions.map(action => {
    if (action == null || typeof action !== 'object')
      throw new Error('Invalid historical action')
    const input = action as Record<string, unknown>
    const converted = mapPlayers(input, idOf)
    if (input.setup != null) {
      const old = asLegacyGameSetup(input.setup)
      converted.setup = convert(old)
      nextId = old.identities.nextId
    } else if (input.type === 'lineup' && input.kind === 'addPlayer') {
      converted.player = idOf(nextId++)
    }
    return converted
  })
  // The drawing detail also holds session references in fielding routes and
  // runner credits. Other numeric fields (positions, bases and counts) stay put.
  const detail = (raw: unknown, parent = ''): unknown => {
    if (Array.isArray(raw)) return raw.map(value => detail(value, parent))
    if (raw == null || typeof raw !== 'object') return raw
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        key === 'id' && (parent === 'player' || parent === 'runner')
          ? idOf(value)
          : detail(value, key)
      ])
    )
  }
  return {
    ...record,
    version: 2,
    setupBefore: convert(initial),
    actions,
    ...(record.detail == null ? {} : { detail: detail(record.detail) })
  }
}
