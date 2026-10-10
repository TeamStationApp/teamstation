import { asGroupRef, type GroupRef, isRecord } from './groupCreation'

export interface ParentAction {
  operation: 'attach' | 'detach'
  child: GroupRef
  parent: GroupRef
}
export interface ParentEffect {
  child: GroupRef
  parent: GroupRef
  operation: 'attach' | 'detach'
}
export interface ParentPreview {
  actions: ParentAction[]
  effects: ParentEffect[]
  expected: Record<string, string>
  explanation: string[]
}

export function asParentActions(raw: unknown): ParentAction[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50)
    throw new TypeError('Choose one to fifty parent changes')
  return raw.map(value => {
    if (
      !isRecord(value) ||
      (value.operation !== 'attach' && value.operation !== 'detach')
    )
      throw new TypeError('Choose attach or detach')
    const child = asGroupRef(value.child)
    const parent = asGroupRef(value.parent)
    if (
      child.kind === 'league' ||
      parent.kind === 'team' ||
      (child.kind === 'season' && parent.kind !== 'league')
    )
      throw new TypeError('That parent relationship is not supported')
    return { operation: value.operation, child, parent }
  })
}
export function groupKey(group: GroupRef): string {
  return `${group.kind}:${group.id}`
}

export function asParentPreview(raw: unknown): ParentPreview {
  if (
    !isRecord(raw) ||
    !isRecord(raw.expected) ||
    !Array.isArray(raw.explanation) ||
    !Array.isArray(raw.effects) ||
    raw.explanation.some(row => typeof row !== 'string')
  )
    throw new TypeError('Invalid parent preview')
  const expected: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw.expected)) {
    if (typeof value !== 'string')
      throw new TypeError('Invalid expected parent state')
    expected[key] = value
  }
  return {
    actions: asParentActions(raw.actions),
    effects: raw.effects.map(effect => asParentActions([effect])[0]),
    expected,
    explanation: raw.explanation as string[]
  }
}
