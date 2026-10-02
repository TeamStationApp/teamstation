/** Enough of a player to order a roster by. */
export interface RosterOrderPlayer {
  jersey: string
  fullName: string
}

/**
 * A team's players in roster order: jerseys that are all digits first,
 * lowest number first (0 before 00); then any other jersey text; then
 * players with no number. Within each, by name, and by id when names match,
 * so the order never depends on how the list arrived. The list given is left
 * as it was.
 */
export function byJersey(
  ids: readonly number[],
  players: Record<number, RosterOrderPlayer>
): number[] {
  const tier = (jersey: string): number =>
    /^\d+$/.test(jersey) ? 0 : jersey === '' ? 2 : 1
  const key = (id: number): { jersey: string; tier: number } => {
    const jersey = players[id].jersey.trim()
    return { jersey, tier: tier(jersey) }
  }
  return [...ids].sort((a, b) => {
    const left = key(a)
    const right = key(b)
    if (left.tier !== right.tier) return left.tier - right.tier
    if (left.tier === 0) {
      const number = Number(left.jersey) - Number(right.jersey)
      if (number !== 0) return number
      const length = left.jersey.length - right.jersey.length
      if (length !== 0) return length
    } else if (left.tier === 1) {
      const text = left.jersey.localeCompare(right.jersey, undefined, {
        numeric: true
      })
      if (text !== 0) return text
    }
    const name = players[a].fullName.localeCompare(players[b].fullName)
    return name !== 0 ? name : a - b
  })
}
