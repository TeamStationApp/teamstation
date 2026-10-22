import { asBoolean, asObject, asString } from 'cleaners'

import { asSessionUser, type SessionUser } from '../../common/api'
import { asUserId, type UserId } from '../../common/userId'

/**
 * Who the phone's last good `whoAmI` said was signed in, kept beside the
 * token. With no signal at launch it is the session the app opens on, and
 * its id names the cache file.
 */
export interface StoredUser {
  id: UserId
  displayName: string
  isAdmin: boolean
}

export const asStoredUser = asObject({
  id: asUserId,
  displayName: asString,
  isAdmin: asBoolean
})

/** What is kept of a session's user. */
export function storedUserOf(user: SessionUser): StoredUser {
  return { id: user.id, displayName: user.displayName, isAdmin: user.isAdmin }
}

/** The session a stored user opens with while the server cannot be asked. */
export function sessionUserOf(user: StoredUser): SessionUser {
  return asSessionUser({
    id: user.id,
    displayName: user.displayName,
    isAdmin: user.isAdmin
  })
}
