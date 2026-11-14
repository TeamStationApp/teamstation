import { asArray, asBoolean, asObject, asOptional, asString } from 'cleaners'

import { asArgonParameters, asHex, asPasswordUpdate } from './passwordProtocol'
import { asGumboId, asUserId } from './userId'

/**
 * The account-wide notification switches: direct messages and mentions, and
 * reminders before the events the person said yes to. Both start off.
 */
export const asAccountNotifications = asObject({
  messages: asBoolean,
  rsvpEvents: asBoolean
})
export type AccountNotifications = ReturnType<typeof asAccountNotifications>
export const NO_ACCOUNT_NOTIFICATIONS: AccountNotifications = {
  messages: false,
  rsvpEvents: false
}
/** A change to either switch; the one left out keeps its value. */
export const asAccountNotificationsBody = asObject({
  messages: asOptional(asBoolean),
  rsvpEvents: asOptional(asBoolean)
})

export const asAccountSettings = asObject({
  user: asObject({
    id: asUserId,
    gumboId: asOptional(
      (raw: unknown) => (raw == null ? null : asGumboId(raw)),
      null
    ),
    displayName: asString,
    email: asOptional(asString),
    isAdmin: asBoolean,
    avatarUrl: (raw: unknown): string | null =>
      raw === null ? null : asString(raw)
  }),
  hasPassword: asBoolean,
  passwordNeedsUpgrade: asOptional(asBoolean, false),
  passwordParameters: asOptional(
    (raw: unknown) =>
      raw == null
        ? null
        : asObject({
            client: (value: unknown) => asArgonParameters(value),
            server: (value: unknown) => asArgonParameters(value, true)
          })(raw),
    null
  ),
  newPasswordSalt: asOptional((raw: unknown) => asHex(raw, 16)),
  notifications: asOptional(asAccountNotifications, NO_ACCOUNT_NOTIFICATIONS),
  emails: asArray(
    asObject({
      id: asString,
      email: asString,
      isPrimary: asBoolean,
      isVerified: asOptional(asBoolean, false)
    })
  )
})
type CleanedAccountSettings = ReturnType<typeof asAccountSettings>
export type AccountSettings = Omit<CleanedAccountSettings, 'emails'> & {
  emails: Array<
    Omit<CleanedAccountSettings['emails'][number], 'isVerified'> & {
      isVerified?: boolean
    }
  >
}

export function asAccountName(raw: unknown): string {
  const name = asString(raw).trim().replace(/\s+/g, ' ')
  if (name.length < 1 || name.length > 120) {
    throw new TypeError('Enter a name between 1 and 120 characters')
  }
  return name
}

export function asAccountEmail(raw: unknown): string {
  const email = asString(raw).trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError('Enter a valid email address')
  }
  return email
}

export const asAccountNameBody = asObject({ displayName: asAccountName })
export const asAccountPasswordBody = asPasswordUpdate
export const asAccountEmailRequest = asObject({
  email: asAccountEmail,
  replaceEmailId: asOptional(asString)
})
export const asAccountEmailConfirmation = asObject({
  requestId: asString,
  code: asString
})
export const asAccountEmailPending = asObject({ requestId: asString })
export const asAccountPrimaryBody = asObject({ emailId: asString })

export const ACCOUNT_PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const ACCOUNT_PICTURE_MAX_BYTES = 10 * 1024 * 1024
export interface AccountPicture {
  contentType: string
  base64: string
}

export function checkAccountPicture(type: string, size: number): void {
  if (!ACCOUNT_PICTURE_TYPES.includes(type)) {
    throw new Error('Choose a JPEG, PNG or WebP picture')
  }
  if (size > ACCOUNT_PICTURE_MAX_BYTES || size <= 0) {
    throw new Error('Choose a picture no larger than 10 MB')
  }
}
