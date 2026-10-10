import { asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'

export const asOnboarding = asObject({
  step: asLiteral('name', 'photo', 'complete'),
  completedAt: (raw: unknown): string | null =>
    raw == null ? null : asString(raw)
})
export type Onboarding = ReturnType<typeof asOnboarding>
