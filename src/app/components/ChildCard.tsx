import React, { useRef, useState } from 'react'
import { Dimensions, Modal, Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Card } from './Card'
import { Emblem } from './Emblem'
import { initialsOf } from './initials'
import { TeamEmblem } from './TeamEmblem'

export interface ChildCardPill {
  label: string
  onPress: () => void
}
export interface ChildCardAction {
  label: string
  onPress: () => void
}
export interface ChildCardProps {
  kind?: 'team' | 'season'
  title: string
  imageUrl: string | null
  /** The line under the name: a season's time frame, a team's record. */
  subtitle?: string
  /** Tappable pills under the name, e.g. the seasons a team plays in. */
  pills?: ChildCardPill[]
  /** The last line, e.g. where a team is from. */
  footer?: string
  onPress: () => void
  /** The ⋮ menu. Without actions the card has no ⋮ at all. */
  actions?: ChildCardAction[]
}

/**
 * One child of a league or a season — a season or a team — as a floating
 * card of its own.
 *
 * The whole card opens the child, so the right edge carries no chevron: it
 * carries the ⋮ menu instead, and pressing the ⋮ opens only the menu. League
 * and season pages share this card, so a team looks the same in both.
 */
export function ChildCard(props: ChildCardProps): React.ReactElement {
  const { title, imageUrl, subtitle, pills, footer, onPress, actions } = props
  const styles = getStyles(useTheme())
  const anchor = useRef<React.ComponentRef<typeof View>>(null)
  const [menuAt, setMenuAt] = useState<{ top: number; right: number }>()
  const openMenu = (): void => {
    const place = (
      x: number,
      y: number,
      width: number,
      height: number
    ): void => {
      const screenWidth = Dimensions.get('window').width
      setMenuAt({
        top: y + height,
        right: Math.max(0, screenWidth - x - width)
      })
    }
    if (anchor.current?.measureInWindow == null) place(0, 0, 0, 0)
    else anchor.current.measureInWindow(place)
  }
  return (
    <Card flush style={styles.card}>
      {/*
        The card's own tap target lies under its content rather than around
        it, so the season pills are its siblings and never buttons inside a
        button. Everything that is not a pill lets the tap through to it.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${title}`}
        onPress={onPress}
        style={({ pressed }) => [styles.underlay, pressed && styles.held]}
      />
      <View style={styles.body}>
        <View style={styles.through}>
          {props.kind === 'team' ? (
            <TeamEmblem name={title} uri={imageUrl} size={3} />
          ) : (
            <Emblem uri={imageUrl} fallback={initialsOf(title)} size={3} />
          )}
        </View>
        <View style={styles.text}>
          <View style={styles.through}>
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
            {subtitle != null && subtitle !== '' && (
              <Text style={styles.subtitle}>{subtitle}</Text>
            )}
          </View>
          {pills != null && pills.length > 0 && (
            <View style={styles.pills}>
              {pills.map(pill => (
                <Pressable
                  key={pill.label}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${pill.label}`}
                  onPress={() => {
                    pill.onPress()
                  }}
                  style={({ pressed }) => [
                    styles.pill,
                    pressed && styles.pressed
                  ]}
                >
                  <Text style={styles.pillText}>{pill.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {footer != null && footer !== '' && (
            <View style={styles.through}>
              <Text style={styles.subtitle}>{footer}</Text>
            </View>
          )}
        </View>
      </View>
      {actions != null && actions.length > 0 && (
        <View ref={anchor} collapsable={false}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`More for ${title}`}
            onPress={openMenu}
            hitSlop={8}
            style={({ pressed }) => [styles.more, pressed && styles.pressed]}
          >
            <MoreDots />
          </Pressable>
        </View>
      )}
      {menuAt != null && actions != null && (
        <Modal
          transparent
          animationType="fade"
          visible
          onRequestClose={() => {
            setMenuAt(undefined)
          }}
        >
          <Pressable
            accessibilityLabel="Close menu"
            style={styles.behind}
            onPress={() => {
              setMenuAt(undefined)
            }}
          />
          <View style={[styles.menu, menuAt]}>
            {actions.map(action => (
              <Pressable
                key={action.label}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={() => {
                  setMenuAt(undefined)
                  action.onPress()
                }}
                style={({ pressed }) => [
                  styles.menuItem,
                  pressed && styles.pressed
                ]}
              >
                <Text style={styles.menuText}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
        </Modal>
      )}
    </Card>
  )
}

/**
 * Three dots drawn as circles. The phone carries a subset of the icon font,
 * and drawing these keeps a glyph out of it.
 */
function MoreDots(): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.dots}>
      <View style={styles.dot} />
      <View style={styles.dot} />
      <View style={styles.dot} />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  underlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  held: { backgroundColor: theme.containerBackgroundColor },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem),
    padding: theme.rem(theme.cardContentInsetRem),
    pointerEvents: 'box-none'
  },
  through: { pointerEvents: 'none' },
  text: {
    flex: 1,
    gap: theme.rem(theme.spaceXsRem),
    pointerEvents: 'box-none'
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  subtitle: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceXsRem),
    pointerEvents: 'box-none'
  },
  pill: {
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.radiusPill,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.1875)
  },
  pillText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600',
    color: theme.activeColor
  },
  more: {
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: theme.rem(theme.cardContentInsetRem)
  },
  dots: { gap: theme.rem(0.1875), alignItems: 'center' },
  dot: {
    width: theme.rem(0.25),
    height: theme.rem(0.25),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.secondaryTextColor
  },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  menu: {
    position: 'absolute',
    minWidth: theme.rem(14),
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    shadowColor: theme.shadowColor,
    shadowOpacity: 1,
    shadowRadius: theme.rem(0.75),
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    paddingVertical: theme.rem(theme.spaceXsRem)
  },
  menuItem: {
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem),
    minHeight: theme.rem(2.75),
    justifyContent: 'center'
  },
  menuText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.dangerColor
  },
  pressed: { opacity: 0.6 }
}))
