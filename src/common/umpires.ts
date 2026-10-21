export interface UmpireLevel {
  id: string
  name: string
  position: number
  inUse: boolean
}
export interface UmpireSettings {
  management: boolean
  credits: boolean
}
export interface UmpireRequirement {
  levelId: string
  levelName: string
  plate: boolean
  fieldCount: number
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
  certifications: Array<{ levelId: string; plate: boolean; field: boolean }>
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
export function umpireSlots(plate: boolean, fieldCount: number): string[] {
  return [
    ...(plate ? ['plate'] : []),
    ...Array.from({ length: fieldCount }, (_, i) => `field:${i + 1}`)
  ]
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
