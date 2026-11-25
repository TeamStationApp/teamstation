import { asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'

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
