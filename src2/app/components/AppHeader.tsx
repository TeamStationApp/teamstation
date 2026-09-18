import React from 'react'
import { Image, Pressable, Text, View } from 'react-native'

import gsLogo from '../assets/gsLogo.png'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Emblem } from './Emblem'
import { Icon } from './Icon'

export interface AppHeaderProps {
  /** The name of the screen you are on. */
  title: string
  /** Set above the title in small caps. Always `GameStation`. */
  overline?: string
  onBack?: () => void
  /** The signed-in person, drawn at the right and opening their account. */
  account?: {
    name: string
    avatarUrl?: string | null
    onPress: () => void
  }
}

/**
 * The bar at the top of every screen.
 *
 * Left to right: the back chevron when there is somewhere to go back to, the
 * GameStation mark, the two-line title, and the signed-in person's picture.
 *
 * The chevron and the mark sit together rather than taking turns — the mark is
 * how you know which app this is, and losing it one screen deep is how an app
 * stops feeling like one thing. The word "Back" is gone with it: the glyph is
 * understood, and the label only took room from the title. It stays as the
 * accessibility name, so nothing is lost to a screen reader.
 *
 * The title is left-justified rather than centred. Centring looked tidy with
 * nothing either side of it and stopped being tidy the moment there was a mark
 * on one side and a face on the other, because the text then sat off-centre
 * against whichever was wider.
 */
export function AppHeader(props: AppHeaderProps): React.ReactElement {
  const { title, overline, onBack, account } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  return (
    <View style={styles.header}>
      {onBack != null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Icon name="chevron_left" color={theme.headerTextColor} />
        </Pressable>
      )}

      <Image
        accessibilityIgnoresInvertColors
        accessibilityLabel="GameStation"
        source={{ uri: gsLogo }}
        style={styles.mark}
      />

      <View style={styles.titles}>
        {overline != null && (
          <Text style={styles.overline} numberOfLines={1}>
            {overline.toUpperCase()}
          </Text>
        )}
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>

      {account != null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Account, ${account.name}`}
          onPress={() => {
            account.onPress()
          }}
          style={({ pressed }) => [styles.account, pressed && styles.pressed]}
        >
          <Emblem
            uri={account.avatarUrl}
            fallback={initials(account.name)}
            shape="circle"
            size={2.25}
          />
        </Pressable>
      )}
    </View>
  )
}

/** Local rather than imported, to keep the header free of a component cycle. */
function initials(name: string): string {
  const words = name.split(/[\s-]+/).filter(word => word.length > 0)
  return words
    .slice(0, 2)
    .map(word => word[0]?.toUpperCase() ?? '')
    .join('')
}

const getStyles = cacheStyles((theme: Theme) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    minHeight: theme.rem(3.75),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem),
    backgroundColor: theme.headerBackgroundColor,
    borderBottomWidth: 1,
    borderBottomColor: theme.headerBorderColor
  },
  back: {
    // A glyph is narrow; the target is not. 44pt is the floor for something
    // this often-used and this close to the edge of the screen.
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: theme.rem(-theme.spaceSmRem)
  },
  mark: {
    width: theme.rem(2),
    height: theme.rem(2),
    resizeMode: 'contain'
  },
  titles: {
    flex: 1,
    alignItems: 'flex-start'
  },
  overline: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.0625),
    color: theme.activeColor
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    color: theme.headerTextColor
  },
  account: {
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: {
    opacity: 0.6
  }
}))
