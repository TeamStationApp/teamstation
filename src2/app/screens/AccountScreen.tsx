import React from 'react'
import { Text, View } from 'react-native'

import type { Session } from '../../common/api'
import { Button, Card, ListRow, Screen, SectionHeader } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface AccountScreenProps {
  session: Session
  onSignOut: () => void
}

/**
 * Who you are signed in as, and the way out.
 *
 * Not in the designs — the drawn set has an Account tab on one screen and no
 * screen behind it. It has to exist anyway: signing out has to live somewhere,
 * and an app that cannot be signed out of on a shared family iPad is a problem
 * rather than a simplification.
 *
 * Deliberately thin. There is nothing here to edit yet: display names come from
 * the PeerTube import and e-mail addresses are what sign-in codes are sent to,
 * so letting either be changed here without the merge work behind it would
 * make duplicates rather than fix them.
 */
export function AccountScreen(props: AccountScreenProps): React.ReactElement {
  const { session, onSignOut } = props
  const styles = getStyles(useTheme())
  const { user } = session

  return (
    <Screen>
      <Card style={styles.identity}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initialsOf(user.displayName)}</Text>
        </View>
        <View style={styles.identityText}>
          <Text style={styles.name}>{user.displayName}</Text>
          {user.email != null && <Text style={styles.email}>{user.email}</Text>}
        </View>
      </Card>

      <View style={styles.section}>
        <SectionHeader title="Account" />
        <Card>
          <ListRow
            title="Signed in as"
            subtitle={user.email ?? user.displayName}
            emblem="✉"
          />
          <View style={styles.divider} />
          <ListRow
            title="Role"
            subtitle={user.isAdmin ? 'Administrator' : 'Member'}
            emblem={user.isAdmin ? '★' : '☺'}
          />
        </Card>
      </View>

      <Button label="Sign out" kind="secondary" block onPress={onSignOut} />

      <Text style={styles.footnote}>
        Your name and e-mail come from the league's records. Ask your league
        administrator to change either one.
      </Text>
    </Screen>
  )
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(word => word.length > 0)
  return words
    .slice(0, 2)
    .map(word => word[0]?.toUpperCase() ?? '')
    .join('')
}

const getStyles = cacheStyles((theme: Theme) => ({
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  avatar: {
    width: theme.rem(3.5),
    height: theme.rem(3.5),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.scoreboardBackground,
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatarText: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.scoreboardAccentColor
  },
  identityText: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  name: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.375),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  email: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  divider: {
    height: 1,
    backgroundColor: theme.defaultBorderColor
  },
  footnote: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  }
}))
