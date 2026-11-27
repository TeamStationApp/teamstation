import React, { useEffect, useState } from 'react'
import { Image, Pressable, Text, View } from 'react-native'

import { Badge } from '../components/Badge'
import { useAnalytics } from '../observability/AnalyticsContext'
import type { Size } from '../player/scoreboardOverlay/overlayLayout'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { coverRect } from './coverRect'
import { openSponsorUrl } from './openSponsorUrl'
import { sendRowEvent, type TrackedRow } from './sponsorRowEvents'
import type { SponsoredTextColor } from './sponsorTypes'

export interface SponsoredScheduleRowProps {
  logoUrl: string
  backgroundUrl: string
  title: string
  message: string
  url: string
  /** Dark when not given. */
  textColor?: SponsoredTextColor
  /** For a test: how the website is opened. */
  onOpen?: (url: string) => void
  /**
   * The Schedule's row this is: given, each press is recorded
   * (`sponsor_row_tapped`) before the website opens. A preview has none.
   */
  tracked?: TrackedRow
}

/** Each text colour and the shadow that keeps it legible on the image. */
export const TEXT_COLORS: Record<
  SponsoredTextColor,
  { color: string; textShadowColor: string }
> = {
  dark: { color: '#1C1C1E', textShadowColor: 'rgba(255,255,255,0.8)' },
  white: { color: '#FFFFFF', textShadowColor: 'rgba(0,0,0,0.75)' }
}

/** A picture's own size, once it has loaded; `null` until then. */
function useNaturalSize(url: string): Size | null {
  const [size, setSize] = useState<Size | null>(null)
  useEffect(() => {
    setSize(null)
    if (url === '') return
    let live = true
    Image.getSize(
      url,
      (width, height) => {
        if (live) setSize({ width, height })
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [url])
  return size
}

/**
 * A sponsored row as it sits in a league's Schedule: the background image
 * covering the card, anchored to its upper-right corner, the logo, a
 * Sponsored badge, the title on one line and the message beneath it in up
 * to three. A press opens the sponsor's website.
 */
export function SponsoredScheduleRow({
  logoUrl,
  backgroundUrl,
  title,
  message,
  url,
  textColor = 'dark',
  onOpen = openSponsorUrl,
  tracked
}: SponsoredScheduleRowProps): React.ReactElement {
  const theme = useTheme()
  const analytics = useAnalytics()
  const styles = getStyles(theme)
  const ink = TEXT_COLORS[textColor]
  const [box, setBox] = useState<Size>({ width: 0, height: 0 })
  const natural = useNaturalSize(backgroundUrl)
  const cover = coverRect(box, natural ?? box, 'right-top')
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Sponsored: ${title}`}
      testID="sponsored-schedule-row"
      onPress={() => {
        if (tracked != null)
          sendRowEvent(analytics, 'sponsor_row_tapped', tracked).catch(
            () => undefined
          )
        onOpen(url)
      }}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout
        setBox({ width, height })
      }}
      style={styles.card}
    >
      {backgroundUrl !== '' && box.width > 0 && (
        <Image
          testID="sponsored-row-background"
          source={{ uri: backgroundUrl }}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          resizeMode="stretch"
          style={{
            position: 'absolute',
            left: cover.x,
            top: cover.y,
            width: cover.w,
            height: cover.h
          }}
        />
      )}
      <View style={styles.row}>
        <View style={styles.logo}>
          {logoUrl !== '' && (
            <Image
              testID="sponsored-row-logo"
              source={{ uri: logoUrl }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              resizeMode="cover"
              style={styles.logoImage}
            />
          )}
        </View>
        <View style={styles.text}>
          <View style={styles.first}>
            <Text style={[styles.title, ink]} numberOfLines={1}>
              {title === '' ? 'Sponsor title' : title}
            </Text>
            <Badge label="Sponsored" compact />
          </View>
          <Text style={[styles.message, ink]} numberOfLines={3}>
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
  logoImage: { width: '100%', height: '100%' },
  text: { flex: 1, minWidth: 0, gap: theme.rem(0.25) },
  first: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.5)
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    textShadowRadius: 3
  },
  message: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    textShadowRadius: 3
  }
}))
