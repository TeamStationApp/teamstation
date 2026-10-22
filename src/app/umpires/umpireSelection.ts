import type { CheckboxModifiers } from '../components/Checkbox'

export function selectedRange(
  ids: string[],
  first: number,
  last: number,
  held: string[]
): string[] {
  return [
    ...new Set([
      ...held,
      ...ids.slice(Math.min(first, last), Math.max(first, last) + 1)
    ])
  ]
}
export function selectUmpire(
  ids: string[],
  selected: string[],
  index: number,
  anchor: number | undefined,
  modifiers: CheckboxModifiers = {}
): string[] {
  if (modifiers.shiftKey === true)
    return selectedRange(
      ids,
      anchor != null && anchor >= 0 && anchor < ids.length ? anchor : index,
      index,
      modifiers.ctrlKey === true || modifiers.metaKey === true ? selected : []
    )
  const id = ids[index]
  return selected.includes(id)
    ? selected.filter(value => value !== id)
    : [...selected, id]
}
/** Resolve the actual row boundary, independently of where the finger started. */
export function touchedRow(
  y: number,
  top: number,
  height: number,
  index: number,
  count: number
): number {
  return Math.max(
    0,
    Math.min(count - 1, index + Math.floor((y - top) / height))
  )
}
export interface UmpireSelectorProps {
  label: string
  checked: boolean
  disabled: boolean
  index: number
  count: number
  testID: string
  onToggle: (modifiers?: CheckboxModifiers) => void
  onRangeStart: () => void
  onRange: (last: number) => void
}
