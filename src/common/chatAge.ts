import { asBoolean, asEither, asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'
import { strictBody } from './strictBody'

/** How an account's chat was unlocked: Apple's age range, or the age sheet. */
export type ChatAgeSource = 'apple' | 'self'

/** `GET` and `PUT /me/account/chat-age`: whether chat is unlocked, how and when. */
export const asChatAge = asObject({
  confirmed: asBoolean,
  source: asLiteral('apple', 'self', null),
  confirmedAt: asEither(asLiteral(null), asString)
})
export type ChatAge = ReturnType<typeof asChatAge>

/** The body of `PUT /me/account/chat-age`: `{ source }` and nothing else. */
export function asChatAgeBody(raw: unknown): { source: ChatAgeSource } {
  const { source } = strictBody(raw, ['source'], '{ source }', 'Only a source')
  if (source !== 'apple' && source !== 'self') {
    throw new TypeError('The source is apple or self')
  }
  return { source }
}
