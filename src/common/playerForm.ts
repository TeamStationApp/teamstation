import { JERSEY_MAX_LENGTH, type PlayerPosition } from './playerSettings'

/** What the app-theme player form holds. */
export interface PlayerFormValue {
  firstName: string
  lastName: string
  jersey: string
  throws: 'left' | 'right' | null
  bats: 'left' | 'right' | 'switch' | null
  positions: PlayerPosition[]
}

export const emptyPlayerForm = (): PlayerFormValue => ({
  firstName: '',
  lastName: '',
  jersey: '',
  throws: 'right',
  bats: 'right',
  positions: []
})

/**
 * Why the form cannot be sent, or undefined when it can: a name when the
 * name is the form's to set, and a jersey of digits, short enough to store.
 */
export function playerFormError(
  value: PlayerFormValue,
  { nameRequired }: { nameRequired: boolean }
): string | undefined {
  if (nameRequired && `${value.firstName}${value.lastName}`.trim() === '')
    return 'Enter a player name.'
  const jersey = value.jersey.trim()
  if (!/^\d*$/.test(jersey)) return 'Use digits for the jersey number.'
  if (jersey.length > JERSEY_MAX_LENGTH)
    return `A jersey number is at most ${JERSEY_MAX_LENGTH} characters.`
}
