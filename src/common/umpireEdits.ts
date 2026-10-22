import type { UmpirePerson } from './umpires'

export type UmpireState = Pick<UmpirePerson, 'certifications'> | null
export interface UmpireEdit {
  userId: string
  before: UmpireState
  after: UmpireState
}
/** Absent and explicitly false permissions mean the same thing. */
export function umpireStateKey(state: UmpireState): string {
  return state == null
    ? 'absent'
    : JSON.stringify(
        state.certifications
          .filter(c => c.enabled)
          .map(c => [c.levelId, c.typeId])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      )
}
export function umpireEdits(
  baseline: UmpirePerson[],
  draft: UmpirePerson[]
): UmpireEdit[] {
  const old = new Map(baseline.map(p => [p.id, p]))
  const next = new Map(draft.map(p => [p.id, p]))
  return [...new Set([...old.keys(), ...next.keys()])].flatMap(userId => {
    const before = old.get(userId) ?? null
    const after = next.get(userId) ?? null
    return umpireStateKey(before) === umpireStateKey(after)
      ? []
      : [
          {
            userId,
            before:
              before == null ? null : { certifications: before.certifications },
            after:
              after == null ? null : { certifications: after.certifications }
          }
        ]
  })
}
