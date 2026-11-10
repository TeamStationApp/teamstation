/** A reset is not acknowledgement of a tap; only a new request in the same capture qualifies. */
export function hasNewFocusRequest(previous: string, next?: string): boolean {
  const before = previous.split(':')
  const after = next?.split(':')
  return (
    before.length === 3 &&
    after?.length === 3 &&
    before[0] === 'focus-state' &&
    after[0] === 'focus-state' &&
    before[1] !== '' &&
    before[1] === after[1] &&
    after[2] !== '' &&
    after[2] !== 'none' &&
    after[2] !== before[2]
  )
}
