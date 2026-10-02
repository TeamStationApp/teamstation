import React from 'react'
import { Platform, Pressable, View } from 'react-native'

import { useInsets } from '../platform/safeArea'
import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { GlassView } from './GlassView'
import { Icon, type IconName } from './Icon'
import { floatingNavBottom } from './navClearance'

export type NavTabId = 'home' | 'videos' | 'schedule'

export interface NavTab {
  id: NavTabId
  label: string
  icon: IconName
}

/**
 * The three places the app goes.
 *
 * The designs disagreed: the home screen drew Teams / Videos / Schedule /
 * Seasons, the team hub drew Team Hub / Live Cams / League / Account. Picking
 * one meant deciding what the app is, so: Home carries both the teams and the
 * seasons, which is what Paul asked for on that screen, so a separate Seasons
 * tab would lead to the half of a screen the user just left. Live Cams is not
 * built.
 *
 * Account is **not** here. It is reached by tapping your own picture at the
 * top right, which is where every application with a signed-in person puts it,
 * and which frees a quarter of the bar for the three things you actually move
 * between. Signing out still lives on that screen; it is simply not a
 * destination you navigate to as often as the ones that are left.
 */
export const NAV_TABS: NavTab[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'videos', label: 'Videos', icon: 'smart_display' },
  { id: 'schedule', label: 'Schedule', icon: 'event' }
]

export type NavMode = 'floating' | 'header'

/**
 * How much bigger the capsule is than the row in the header.
 *
 * The header's three sit on a 3rem bar beside a face and cannot grow without
 * moving it; the capsule floats over the content with nothing to answer to,
 * and it is the one a thumb actually uses — at a ball field, often
 * one-handed, in the sun. Paul asked for a fifth again, glyphs and gap alike,
 * so it is one number and everything the capsule draws is measured from it.
 */
const FLOATING_SCALE = 1.2
/** The inline size everything else uses, grown by the same fifth. */
const FLOATING_ICON_REM = 1.25 * FLOATING_SCALE
/** The disc behind a glyph, which is also the whole of the touch target. */
const FLOATING_DISC_REM = 2.75 * FLOATING_SCALE
/**
 * The capsule's own breathing room, around the discs — **the same on every
 * side**, and that is the whole of it rather than a detail.
 *
 * The end of a capsule is a semicircle whose radius is half the capsule's
 * height, so it is centred half a height in from the end. The selected disc
 * is centred one horizontal padding plus its own radius in from the same end.
 * Those two only coincide when the horizontal padding equals the vertical
 * one — and when they coincide, the disc and the end arc are concentric and
 * the gap between them is the same all the way round.
 *
 * They did not. Vertically the disc had 3.6 points and at the ends it had
 * 9.6, which put its centre six points inboard of the arc's, and it read as
 * cramped above and below and adrift from the end it sits in.
 */
const FLOATING_PAD_REM = 0.375 * FLOATING_SCALE
/**
 * How far the capsule floats off the bottom of the window, on Android and
 * on the web.
 *
 * On iOS this is not added. The home-indicator inset is already that gap,
 * and a nav capsule can sit against it.
 */
export const FLOATING_BOTTOM_REM = 1
/**
 * The gap between the capsule and the last thing above it.
 *
 * Half a rem left the last button on a page touching the capsule at the
 * bottom of a list, which reads as the two being one control. Twice the
 * margin the content keeps at its left and right edges, which is the widest
 * gap anything in the app leaves, because this is the one place where a stray
 * thumb lands on the wrong thing.
 */
const FLOATING_GAP_REM = 2

/**
 * How much room a screen has to leave under its last row.
 *
 * The capsule floats over the content rather than sitting in a bar beneath
 * it, so nothing reserves this space on a screen's behalf — without it the
 * bottom team on the home screen reads through frosted glass. Exported so the
 * screens ask rather than repeat a number that would then have to be kept in
 * step with the capsule's size.
 */
export const NAV_CLEARANCE_REM =
  FLOATING_BOTTOM_REM +
  FLOATING_DISC_REM +
  FLOATING_PAD_REM * 2 +
  // The capsule's hairline border, top and bottom. Two pixels, and left out
  // the gap would be two pixels short of the one it says it is.
  2 / 16 +
  FLOATING_GAP_REM

export interface AppNavProps {
  selected: NavTabId
  onSelect: (id: NavTabId) => void
  /** A capsule floating over the content, or a row inside the header. */
  mode: NavMode
}

/**
 * Three icons, and no words.
 *
 * On a narrow screen they float over the content in a capsule rather than
 * partitioning it with a bar; on a wide one the same three sit in the header
 * beside the account picture, and there is no sidebar at all. A rail cost 176
 * pixels of every wide window to say three words that three glyphs say.
 *
 * The labels are gone from the paint and kept for the screen reader. Three
 * glyphs that never move are learned in a day; what a person actually needs
 * naming is the screen they are on, which the header says.
 */
export function AppNav(props: AppNavProps): React.ReactElement {
  const { selected, onSelect, mode } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const floating = mode === 'floating'
  // Off the bottom of the window on a page. On iOS, against the home
  // indicator: the inset is the gap, and the capsule adds nothing past it.
  // Android keeps the margin above its own navigation inset.
  const insets = useInsets()
  const floatingBottom = floatingNavBottom(
    Platform.OS,
    theme.rem(FLOATING_BOTTOM_REM),
    insets.bottom
  )

  const capsule = theme.rem(2.5)

  return (
    <GlassView
      accessibilityRole="tablist"
      // Interactive, unlike the header: this is the one surface a thumb
      // presses, and on iOS 26 that is what makes the glass deform under it
      // the way the system's own bars do.
      interactive={floating}
      // A pill in both places. In the header this used to ask for a radius of
      // zero, and iOS duly drew a square-cornered pane of glass *on* the
      // glass header — which reads as a rendering fault rather than as a
      // surface. The floating capsule's own language, at the smaller size.
      radius={floating ? capsule : theme.rem(1.25)}
      // The capsule asks for the clear style: it is a row of glyphs with
      // nothing written on the material, so it can afford the transparency,
      // and the refraction is the whole point of it. The header keeps
      // `regular`, because a title does sit on that one and has to stay
      // readable over whatever scrolls under it.
      clear={floating}
      // In the header this row is already sitting on glass. On iOS that is
      // the effect that was asked for and it stays; anything that has to fall
      // back draws nothing, because a flat tint over the header reads as a
      // square-cornered box around the three icons rather than as a surface.
      fallbackFill={floating}
      style={[
        styles.container,
        floating ? styles.floating : styles.inHeader,
        floating && { bottom: floatingBottom }
      ]}
    >
      {NAV_TABS.map(tab => {
        const isSelected = tab.id === selected
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={tab.label}
            onPress={() => {
              onSelect(tab.id)
            }}
            style={({ pressed }) => [
              styles.item,
              floating && styles.itemFloating,
              pressed && styles.pressed
            ]}
          >
            {/*
              The target and the paint are different boxes. The target is 44pt
              wherever it is; the disc behind the selected icon is the size of
              the account picture beside it in the header, and the full target
              in the capsule, where there is nothing to match.
            */}
            <View
              style={[
                floating ? styles.discFloating : styles.discInHeader,
                isSelected && styles.discSelected
              ]}
            >
              <Icon
                name={tab.icon}
                size={floating ? FLOATING_ICON_REM : undefined}
                color={
                  isSelected ? theme.navActiveColor : theme.navInactiveColor
                }
              />
            </View>
          </Pressable>
        )
      })}
    </GlassView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  floating: {
    // Over the content, not beside it: a bar across the bottom of a phone is a
    // strip of chrome under the thing somebody came to look at.
    position: 'absolute',
    bottom: theme.rem(FLOATING_BOTTOM_REM),
    alignSelf: 'center',
    // Half again on the gap: with no labels between them the three glyphs read
    // as one shape at the spacing the rest of the app uses. And then the
    // capsule's own fifth on top of that.
    gap: theme.rem(theme.spaceXsRem * 1.5 * FLOATING_SCALE),
    // One number, four sides. See `FLOATING_PAD_REM`.
    padding: theme.rem(FLOATING_PAD_REM),
    borderRadius: theme.rem(2.5),
    // A hairline gives the capsule an edge to read against scrolling content.
    // The **shadow** does not come with it on iOS: the system material draws
    // its own, and a second one spread a soft shape past the first.
    //
    // The hairline itself was not the fault it looked like. What made the
    // capsule appear to have a second, slightly larger pill behind it was the
    // glass being a *different shape* from this border — the material clipped
    // itself with a squircle at a radius larger than half its height, which
    // pulls the ends in and points them, while this border drew a true
    // capsule. Two shapes, nearly aligned, reading as two pills. With the
    // material clamped to a real capsule (`TSGlassView.mm`) the two coincide
    // and the hairline does what it was always for.
    ...Platform.select({
      ios: { borderWidth: 1, borderColor: theme.glassBorderColor },
      default: {
        borderWidth: 1,
        borderColor: theme.glassBorderColor,
        shadowColor: '#000000',
        shadowOpacity: 0.18,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 }
      }
    }),
    // Android resolves `zIndex` against elevation, so the capsule needs a
    // number higher than anything that scrolls beneath it or an elevated
    // button passing under is painted on top of it.
    elevation: elevationFor(12),
    zIndex: 5
  },
  inHeader: {
    gap: theme.rem(theme.spaceXsRem),
    // The shape the glass above is cut to, so the two agree.
    borderRadius: theme.rem(1.25),
    overflow: 'hidden',
    // The breathing room belongs to the pill, and the pill only exists where
    // there is real glass to draw it — `fallbackFill` sees to that. Padding
    // is layout rather than paint, though, so left unguarded it moved the
    // three destinations four points left *in the browser*, where nothing is
    // drawn around them at all. Measured against production at 1032: same
    // icon pitch, same avatar, and this was the only difference.
    ...Platform.select({
      ios: { paddingHorizontal: theme.rem(theme.spaceXsRem) },
      default: {}
    })
  },
  item: {
    // The paint shrank when the labels went; the target did not. A thumb at a
    // ball field, often one-handed, is the thing being designed for.
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center'
  },
  itemFloating: {
    minWidth: theme.rem(FLOATING_DISC_REM),
    minHeight: theme.rem(FLOATING_DISC_REM)
  },
  discFloating: {
    width: theme.rem(FLOATING_DISC_REM),
    height: theme.rem(FLOATING_DISC_REM),
    borderRadius: theme.rem(FLOATING_DISC_REM / 2),
    // Android draws a background right to the edges of the view unless it is
    // told to clip to the corner radius as well, so the disc behind the
    // selected glyph came out a square.
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center'
  },
  discInHeader: {
    // The account picture's size, so the row reads as one line of circles
    // rather than three large ones and a small one.
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(1),
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center'
  },
  discSelected: {
    // With no label to bolden, the selected tab needs to differ by more than a
    // shade of grey.
    backgroundColor: theme.containerBackgroundColor
  },
  pressed: {
    opacity: 0.6
  }
}))
