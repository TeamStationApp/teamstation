import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { Badge } from '../components/Badge'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface SponsoredScheduleRowProps {
  logoUrl: string
  backgroundUrl: string
  title: string
  message: string
  url: string
}

/**
 * A sponsored row as it would sit in a league's Schedule: the background
 * image in the card's place, anchored to its upper-right corner, the logo,
 * a Sponsored badge, the title on one line and the message beneath it. A
 * click opens the sponsor's website in a new tab.
 */
export function SponsoredScheduleRow({
  logoUrl,
  backgroundUrl,
  title,
  message,
  url
}: SponsoredScheduleRowProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const open = (): void => {
    if (url.startsWith('https://')) window.open(url, '_blank', 'noopener')
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Sponsored: ${title}`}
      testID="sponsored-schedule-row"
      onPress={open}
      style={styles.card}
    >
      {backgroundUrl !== '' && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url("${backgroundUrl}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'right top'
          }}
        />
      )}
      <View style={styles.row}>
        <View style={styles.logo}>
          {logoUrl !== '' && (
            <img
              src={logoUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          )}
        </View>
        <View style={styles.text}>
          <View style={styles.first}>
            <Text style={styles.title} numberOfLines={1}>
              {title === '' ? 'Sponsor title' : title}
            </Text>
            <Badge label="Sponsored" compact />
          </View>
          <Text style={styles.message} numberOfLines={3}>
            {message === '' ? 'Sponsor message' : message}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    position: 'relative',
    minHeight: theme.rem(7),
    justifyContent: 'center',
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.cardContentInsetRem),
    padding: theme.rem(theme.cardContentInsetRem)
  },
  logo: {
    width: theme.rem(3.5),
    height: theme.rem(3.5),
    borderRadius: theme.rem(0.5),
    overflow: 'hidden',
    backgroundColor: theme.containerBackgroundColor
  },
  text: { flex: 1, minWidth: 0, gap: theme.rem(0.25) },
  first: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.5)
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    textShadowColor: 'rgba(255,255,255,0.8)',
    textShadowRadius: 3
  },
  message: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    textShadowColor: 'rgba(255,255,255,0.8)',
    textShadowRadius: 3
  }
}))
