import { asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'

export const EXPECTED_ACTOR_HEADER = 'x-teamstation-expected-actor'
export const ACCOUNT_SWITCH_EVENT = 'teamstation.account-switch'

export const SIGNED_OUT_ACTOR = 'signed-out'

export function socketForActor(url: string, actor: string | undefined): string {
  if (actor == null) return url
  const address = new URL(url)
  address.searchParams.set('expectedActor', actor)
  return address.toString()
}

export function socketActorMatches(
  url: string | undefined,
  actor: string | undefined
): boolean {
  const expected = new URL(
    url ?? '/',
    'https://socket.invalid'
  ).searchParams.get('expectedActor')
  return expected == null || expected === (actor ?? SIGNED_OUT_ACTOR)
}

export const asAccountSwitch = asObject({
  currentId: asString,
  targetId: asString
})
export type AccountSwitch = ReturnType<typeof asAccountSwitch>

export const asSwitchPrompt = asObject({
  reason: asLiteral('confirmAccountSwitch'),
  confirmation: asAccountSwitch,
  currentLabel: asString,
  targetLabel: asString
})
export type SwitchPrompt = ReturnType<typeof asSwitchPrompt>
