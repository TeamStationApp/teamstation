import { asArray, asBoolean, asObject, asString } from 'cleaners'

import { isRecord } from './groupCreation'
import { asUserId } from './userId'

export const asNodeAccount = asObject({
  userId: asUserId,
  displayName: asString,
  email: (value: unknown): string | null =>
    value == null ? null : asString(value),
  isNodeAdmin: asBoolean,
  suspended: asBoolean,
  loginEnabled: asBoolean,
  canRemoveNodeRole: asBoolean,
  avatarUrl: (value: unknown): string | null =>
    value == null ? null : asString(value)
})
export const asNodeAccounts = asArray(asNodeAccount)
export type NodeAccount = Omit<
  ReturnType<typeof asNodeAccount>,
  'avatarUrl'
> & { avatarUrl?: string | null }
export interface NodeAccountChange {
  isNodeAdmin?: boolean
  suspended?: boolean
}
export function asNodeAccountChange(raw: unknown): NodeAccountChange {
  if (
    !isRecord(raw) ||
    (raw.isNodeAdmin === undefined && raw.suspended === undefined)
  )
    throw new TypeError('Choose a node role or account status change')
  if (
    Object.keys(raw).some(key => key !== 'isNodeAdmin' && key !== 'suspended')
  )
    throw new TypeError('Choose a node role or account status change')
  const result: NodeAccountChange = {}
  if (raw.isNodeAdmin !== undefined)
    result.isNodeAdmin = asBoolean(raw.isNodeAdmin)
  if (raw.suspended !== undefined) result.suspended = asBoolean(raw.suspended)
  return result
}
