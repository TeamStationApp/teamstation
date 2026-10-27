import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { edgeMarginRem } from '../layout/margins'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { BuildInfoModal } from './BuildInfoModal'
import { Emblem } from './Emblem'
import { GlassView } from './GlassView'
import { Icon } from './Icon'
import { TsMark } from './TsMark'
import { useBreakpoint } from './useBreakpoint'

export interface AppHeaderProps {
  apiBaseUrl?: string
  buildsClient?: TeamStationClient
  /** The name of the screen, centred. Absent on screens that say it below. */
  title?: string
  /** Home only. Everywhere else the screen says what it is. */
  showMark?: boolean
  onBack?: () => void
  /**
   * What has scrolled out of view, handed up to the header.
   *
   * A team's name, a list's filter pills, a game's score. It takes the middle
   * when it is there, because it is the same information the title would have
   * carried and never both at once.
   */
  handoff?: React.ReactNode
  /** An opt-in two-line identity can grow with accessibility text size. */
  contentHeight?: number
  /** The three destinations, on a wide window. */
  nav?: React.ReactNode
  umpire?: React.ReactNode
  /** An opt-in minimum for a scene's trailing controls, including scaled labels. */
  navMinWidth?: number
  /** The signed-in person, drawn at the right and opening their account. */
  account?: {
    name: string
    avatarUrl?: string | null
    onPress: () => void
  }
  /** Measured by the shell, which needs the height for everything it overlays. */
  onHeight?: (height: number) => void
  /** Whether the signed-in person is a site administrator. */
  isAdmin?: boolean
  notifications?: { pending: boolean; onPress: () => void }
  /**
   * The button that opens Tess's chat, and closes it again, between the
   * umpire's and Notifications. Absent where Tess is not offered.
   */
  tess?: { onPress: () => void; open: boolean }
}

/**
 * The bar at the top of every screen, and it says as little as possible.
 *
 * It used to say `TEAMSTATION` and then the name of the screen underneath,
 * which on the home screen meant reading the name of the app twice on a screen
 * that already has the mark in the corner. Now: the mark on home only, the
 * screen's name centred where a screen has one to give, and otherwise nothing
 * at all until something scrolls up into it.
 *
 * It is glass, and it sits **over** the content rather than above it, so the
 * page moves under it. Everything that has to clear it — the content's top
 * padding, the pegged player — measures `onHeight` rather than repeating a
 * number that would then have to be kept in step.
 */
export function AppHeader(props: AppHeaderProps): React.ReactElement {
  const [about, setAbout] = useState(false)
  const {
    title,
    showMark = false,
    onBack,
    handoff,
    nav,
    account,
    onHeight
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const breakpoint = useBreakpoint()
  const wide = breakpoint !== 'phone'
  // The glass runs under the status bar and the island, which is what makes it
  // glass; the row inside it starts below them. The height reported through
  // `onHeight` is the whole thing, so the content's top padding and the pegged
  // picture clear the bar and the inset together without either of them
  // knowing an inset exists.
  //
  // Held sideways the insets are at the sides instead, and the margin takes
  // whichever is wider — the design's, or the corner's.
  const insets = useInsets()
  const margin = theme.rem(edgeMarginRem(theme, wide ? 'tablet' : 'phone'))

  return (
    <>
      <GlassView
        style={[
          styles.header,
          wide && styles.headerWide,
          {
            height:
              Math.max(theme.rem(3), props.contentHeight ?? 0) + insets.top,
            paddingTop: insets.top,
            paddingLeft: Math.max(margin, insets.left),
            paddingRight: Math.max(margin, insets.right)
          }
        ]}
        onLayout={event => {
          onHeight?.(event.nativeEvent.layout.height)
        }}
      >
        {/*
        Three columns of equal weight, so the middle is centred in the header
        rather than in the space left over. With `flex: 1` on the title alone
        it drifted as the left side changed — a chevron on one screen, a mark
        on another, neither on a third.
      */}
        {/*
        Left-justified, beside the mark, which is where every other title in
        the app sits. Centring it looked tidy in isolation and broke the one
        line everything else is aligned to.
      */}
        <View testID="headerLeading" style={styles.side}>
          {onBack != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={onBack}
              style={({ pressed }) => [styles.back, pressed && styles.pressed]}
            >
              {/* `size` is in rem, like every other size in the app: 2.5 is
                double the 1.25 default. */}
              <Icon
                name="chevron_left"
                size={2.5}
                color={theme.headerTextColor}
              />
            </Pressable>
          )}
          {showMark && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.about_title}
              onPress={() => {
                setAbout(true)
              }}
              style={[styles.mark, wide && styles.markWide]}
            >
              <TsMark size={1.75} />
            </Pressable>
          )}
          {handoff != null ? (
            <View testID="headerHandoff" style={styles.handoffLeft}>
              {handoff}
            </View>
          ) : (
            title != null && (
              // In a box of its own that takes only the room the back button
              // and the trailing controls leave. A phone lays a bare text
              // out at its full width in this row and never truncates it, so
              // a long title ran under the bell.
              <View testID="headerTitle" style={styles.titleBox}>
                <Text
                  style={styles.title}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {title}
                </Text>
              </View>
            )
          )}
        </View>

        <View
          testID="headerTrailing"
          style={[
            styles.side,
            styles.sideEnd,
            props.navMinWidth != null && {
              minWidth: Math.max(theme.rem(3), props.navMinWidth)
            }
          ]}
        >
          {nav}
          {props.umpire}
          {props.tess != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.tess_title}
              aria-expanded={props.tess.open}
              onPress={() => {
                props.tess?.onPress()
              }}
              style={({ pressed }) => [
                styles.headerButton,
                pressed && styles.pressed
              ]}
            >
              <Icon
                name="auto_awesome"
                size={1.5}
                color={theme.headerTextColor}
              />
            </Pressable>
          )}
          {props.notifications != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Notifications"
              accessibilityHint={
                props.notifications.pending
                  ? 'Pending approvals'
                  : 'No pending approvals'
              }
              onPress={() => {
                props.notifications?.onPress()
              }}
              style={{
                width: theme.rem(3),
                height: theme.rem(3),
                justifyContent: 'center',
                alignItems: 'center'
              }}
            >
              <Icon
                name="notifications"
                size={1.5}
                color={theme.headerTextColor}
              />
              {props.notifications.pending && (
                <View
                  testID="notification-pending-dot"
                  style={{
                    position: 'absolute',
                    top: theme.rem(0.45),
                    right: theme.rem(0.55),
                    width: theme.rem(0.5),
                    height: theme.rem(0.5),
                    borderRadius: theme.rem(0.25),
                    backgroundColor: theme.dangerColor
                  }}
                />
              )}
            </Pressable>
          )}
          {account != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Account, ${account.name}`}
              onPress={() => {
                account.onPress()
              }}
              style={({ pressed }) => [
                styles.account,
                pressed && styles.pressed
              ]}
            >
              <Emblem
                key={account.avatarUrl}
                uri={account.avatarUrl}
                fallback={initials(account.name)}
                shape="circle"
                size={2}
              />
            </Pressable>
          )}
        </View>
      </GlassView>
      {about && (
        <BuildInfoModal
          client={props.buildsClient}
          apiBaseUrl={props.apiBaseUrl}
          isAdmin={props.isAdmin}
          onClose={() => {
            setAbout(false)
          }}
        />
      )}
    </>
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
    // A fifth shorter than it was. That height goes to the content, which is
    // what a phone is short of.
    //
    // Fixed, not a minimum: everything downstream measures this — the content's
    // top padding, the pegged player, and the point at which a screen hands its
    // own content up here. A header that grew when it took a row of pills made
    // that hand-over point move as the copy arrived, so the copy never quite
    // left again: a ghost of it sat here at ten per cent for ever.
    height: theme.rem(3),
    overflow: 'hidden',
    // The content column's own margin, from the one place that decides it, so
    // the mark starts where the cards below it start rather than half as far
    // in. It widens above a phone because the column does.
    paddingHorizontal: theme.rem(edgeMarginRem(theme, 'phone')),
    borderBottomWidth: 1,
    borderBottomColor: theme.glassBorderColor
  },
  headerWide: {
    paddingHorizontal: theme.rem(edgeMarginRem(theme, 'tablet'))
  },
  // Spelled out rather than `flex: 1`, which a phone reads as unshrinkable.
  side: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: theme.rem(3)
  },
  // The same margin again on the inside edge of the mark, so `Your Home`, a
  // score, or a row of filter pills stands off it by as much as the mark
  // stands off the window. Spacing that belongs to the mark and not to the row
  // it is in: a back chevron is the alternative to the mark and wants its own,
  // much smaller, because the glyph already sits in a target far wider than it
  // is.
  mark: {
    flexShrink: 0,
    marginRight: theme.rem(edgeMarginRem(theme, 'phone'))
  },
  markWide: {
    marginRight: theme.rem(edgeMarginRem(theme, 'tablet'))
  },
  sideEnd: {
    gap: theme.rem(theme.spaceXsRem),
    // Only as wide as the face and the icons in it. Everything else in the
    // header belongs to whatever the screen has handed up — a game's two team
    // names need the room far more than the empty half of a row does.
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    justifyContent: 'flex-end'
  },

  handoffLeft: {
    flex: 1,
    justifyContent: 'center'
  },
  back: {
    // The glyph doubled, and the target is the whole height of the header and
    // as wide as it is tall. It sits at the edge of a phone, which is where a
    // thumb is least accurate.
    minWidth: theme.rem(3),
    minHeight: theme.rem(3),
    alignItems: 'center',
    justifyContent: 'center',
    // Pulled left by exactly the slack the glyph leaves inside its target, so
    // the chevron's own edge lands on the margin rather than the target's.
    marginLeft: theme.rem(-theme.spaceXsRem),
    marginRight: theme.rem(theme.spaceXsRem)
  },
  titleBox: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    justifyContent: 'center'
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.headerTextColor
  },
  headerButton: {
    width: theme.rem(3),
    height: theme.rem(3),
    justifyContent: 'center',
    alignItems: 'center'
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
