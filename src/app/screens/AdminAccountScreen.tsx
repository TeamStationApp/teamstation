import React, { useMemo } from 'react'
import { Text } from 'react-native'

import type { Session, SessionUser, TeamStationClient } from '../../common/api'
import { Screen } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AccountScreen } from './AccountScreen'
import { NODE_ONLY } from './nodeOnly'

/**
 * Another person's Account page, opened by a node administrator from User
 * Management's gear: the page they would see for themselves, showing their
 * name, photo and addresses. Anybody else is told it is not theirs to open.
 */
export function AdminAccountScreen(props: {
  client: TeamStationClient
  session: Session
  allowed: boolean
  userId: string
  /** The signed-in administrator's own account changed, from here. */
  onAccountChanged?: (user: SessionUser) => void
}): React.ReactElement {
  const { client, session, allowed, userId, onAccountChanged } = props
  const styles = getStyles(useTheme())
  const target = useMemo(
    () => ({ userId, api: client.accountOf(userId) }),
    [client, userId]
  )
  if (!allowed)
    return (
      <Screen>
        <Text accessibilityRole="alert" style={styles.hint}>
          {NODE_ONLY}
        </Text>
      </Screen>
    )
  return (
    <AccountScreen
      // A different person is a different page, not this one's edits.
      key={userId}
      session={session}
      client={client}
      target={target}
      onAccountChanged={onAccountChanged}
      onSignOut={() => undefined}
    />
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  hint: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.3)
  }
}))
