export interface UmpireLevel {
  id: string
  name: string
  position: number
  inUse: boolean
}
export interface UmpireType extends UmpireLevel {}
export interface UmpireTypeCount {
  typeId: string
  required: number
  optional: number
}
export interface UmpireCertification {
  levelId: string
  typeId: string
  enabled: boolean
}
export interface UmpirePosition {
  slot: string
  typeId: string
  typeName: string
  ordinal: number
  required: boolean
}
export interface UmpireSettings {
  management: boolean
  credits: boolean
}
export interface UmpireRequirement {
  levelId: string
  levelName: string
  types: UmpireTypeCount[]
}
export interface UmpireSeason {
  id: string
  name: string
  logoUrl: string | null
  requirement: UmpireRequirement | null
}
export interface UmpirePerson {
  id: string
  name: string
  avatarUrl: string | null
  affiliations: string
  certifications: UmpireCertification[]
}
export const UMPIRE_HINTS = [
  'majors',
  'minors',
  'AA',
  'AAA',
  'Intermediate',
  'juniors',
  'high school',
  'college'
]
export function umpireLevelHint(names: string[]): string {
  const used = new Set(names.map(name => name.toLowerCase()))
  return (
    UMPIRE_HINTS.find(name => !used.has(name.toLowerCase())) ?? 'Level name'
  )
}
export function umpirePositions(
  types: UmpireType[],
  counts: UmpireTypeCount[]
): UmpirePosition[] {
  const byId = new Map(counts.map(c => [c.typeId, c]))
  return types.flatMap(type => {
    const count = byId.get(type.id)
    if (count == null) return []
    return Array.from({ length: count.required + count.optional }, (_, i) => ({
      slot: `${type.id}:${i + 1}`,
      typeId: type.id,
      typeName: type.name,
      ordinal: i + 1,
      required: i < count.required
    }))
  })
}
export function umpirePositionName(
  position: UmpirePosition,
  positions: UmpirePosition[]
): string {
  return positions.some(p => p.typeId === position.typeId && p.ordinal > 1)
    ? `${position.typeName} ${position.ordinal}`
    : position.typeName
}
export function umpireLevelName(raw: unknown, existing: string[]): string {
  if (typeof raw !== 'string' || raw.trim() === '')
    throw new TypeError('Enter a level name')
  const name = raw.trim()
  if (name.length > 100)
    throw new TypeError('Level names must be at most 100 characters')
  if (existing.some(held => held.toLowerCase() === name.toLowerCase()))
    throw new TypeError('That level already exists')
  return name
}
