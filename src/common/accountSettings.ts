import { asArray, asBoolean, asObject, asOptional, asString } from 'cleaners'

import { asArgonParameters, asHex, asPasswordUpdate } from './passwordProtocol'
import { asUserId } from './userIdNumber'

export const asAccountSettings = asObject({
  user: asObject({
    id: asUserId,
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
  emails: asArray(
    asObject({ id: asString, email: asString, isPrimary: asBoolean })
  )
})
export type AccountSettings = ReturnType<typeof asAccountSettings>

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
