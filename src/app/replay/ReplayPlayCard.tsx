import React from 'react'
import {
  type LayoutChangeEvent,
  PixelRatio,
  ScrollView,
  Text,
  type TextStyle,
  View,
  type ViewStyle
} from 'react-native'

import type { ScreenRect } from '../field/catcherBounds'
import { useTailFollow } from '../scoring/tailFollow'
import { useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import type { AnnouncerEntry } from './announcerLines'

/** One line of the announcer's words, at the system's own text size. */
export const ANNOUNCER_LINE_HEIGHT = 20
/** How many lines of words the card shows, whatever it holds, where it fits. */
export const ANNOUNCER_LINES = 3
/** The detail line below the words: the situation, or "Paused". */
export const DETAIL_LINE_HEIGHT = 16
/** The card's padding above its words and below its detail line. */
export const CARD_PADDING = 8
/** The card's border. */
export const CARD_BORDER = 2
/** The gap between the words and the detail line. */
export const CARD_GAP = 2
/** The card less its lines: padding, border and the gap. */
export const CARD_CHROME = 2 * CARD_PADDING + 2 * CARD_BORDER + CARD_GAP
/**
 * The largest system text size the card's texts follow, as a multiple of
 * the default. They set it as their `maxFontSizeMultiplier`, and the card's
 * arithmetic stops at the same size, so the two agree.
 */
export const MAX_FONT_SCALE = 2

/**
 * The text size the card's texts are drawn at, as a multiple of the default:
 * the system's, up to MAX_FONT_SCALE. A browser reports 1; its zoom scales
 * the whole page, arithmetic and all.
 */
export function cardFontScale(): number {
  return Math.min(PixelRatio.getFontScale(), MAX_FONT_SCALE)
}

/**
 * How tall one line of the card's words, and one of its detail, is drawn.
 * Measured by `CardLineProbes`: Android 14 and later scale a `lineHeight`
 * by a non-linear curve, so at 1.3× a 20 line is about 23.6, not 26, while
 * `PixelRatio.getFontScale()` still reports the linear 1.3.
 */
export interface CardLineHeights {
  words: number
  detail: number
}

/**
 * The line heights before the probes have measured them: the style's
 * heights times the text size, as iOS and a browser draw them.
 */
export function estimatedLineHeights(
  fontScale: number = cardFontScale()
): CardLineHeights {
  return {
    words: ANNOUNCER_LINE_HEIGHT * fontScale,
    detail: DETAIL_LINE_HEIGHT * fontScale
  }
}

/** The card's height with a words area of `lines` lines of `heights`. */
export function cardHeightOf(lines: number, heights: CardLineHeights): number {
  return CARD_CHROME + heights.detail + lines * heights.words
}

/** The detail strip's padding above and below its line. */
export const STRIP_PADDING = 4

/** The detail strip's height: padding, border and its line of `heights`. */
export function detailStripHeight(heights: CardLineHeights): number {
  return 2 * STRIP_PADDING + 2 * CARD_BORDER + heights.detail
}

/** A line of the announcer's words. */
function wordsStyle(theme: Theme): TextStyle {
  return {
    fontFamily: theme.semiBoldTextFont,
    color: theme.scoringInstructionText,
    fontSize: 15,
    lineHeight: ANNOUNCER_LINE_HEIGHT
  }
}

/** The detail line. */
function detailStyle(theme: Theme): TextStyle {
  return {
    fontFamily: theme.regularTextFont,
    color: theme.scoringCountdownColor,
    fontSize: 12,
    lineHeight: DETAIL_LINE_HEIGHT
  }
}

/**
 * Two hidden one-line Texts, in the words' and the detail's styles, whose
 * laid-out heights are the card's line heights as the system draws them.
 * Each holds one fixed line, so what it measures never depends on how many
 * lines the card shows, and the measurement cannot loop through a relayout.
 */
export function CardLineProbes(props: {
  onMeasure: (part: keyof CardLineHeights, height: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const { onMeasure } = props
  const probe = (
    part: keyof CardLineHeights,
    style: TextStyle
  ): React.ReactElement => (
    <Text
      testID={`replay-line-probe-${part}`}
      numberOfLines={1}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      onLayout={(event: LayoutChangeEvent) => {
        const { height } = event.nativeEvent.layout
        if (height > 0) onMeasure(part, height)
      }}
      style={{ ...style, position: 'absolute', left: 0, top: 0 }}
    >
      Ag
    </Text>
  )
  return (
    <View
      testID="replay-line-probes"
      pointerEvents="none"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', left: 0, top: 0, opacity: 0 }}
    >
      {probe('words', wordsStyle(theme))}
      {probe('detail', detailStyle(theme))}
    </View>
  )
}

/**
 * The card's line heights, measured by the probes it returns once they are
 * laid out, estimated from the text size until then. The screen draws the
 * probes and gives the heights to the card and to its deck arithmetic, so
 * the line count, the card's height and the deck's top all use the same.
 */
export function useCardLineHeights(): {
  heights: CardLineHeights
  probes: React.ReactElement
} {
  const [measured, setMeasured] = React.useState<Partial<CardLineHeights>>({})
  const onMeasure = React.useCallback(
    (part: keyof CardLineHeights, height: number) => {
      setMeasured(old =>
        old[part] === height ? old : { ...old, [part]: height }
      )
    },
    []
  )
  const estimate = estimatedLineHeights()
  return {
    heights: {
      words: measured.words ?? estimate.words,
      detail: measured.detail ?? estimate.detail
    },
    probes: <CardLineProbes onMeasure={onMeasure} />
  }
}

export interface ReplayPlayCardProps {
  /**
   * The sentences said, oldest first: what the announcer says, the newest
   * last. The card shows the last three lines of them.
   */
  lines: readonly AnnouncerEntry[]
  /** Where the game stands, or "Paused". */
  detail: string
  /** The catcher on screen; the card hangs below. Hidden until known. */
  catcher: ScreenRect | null
  /** The screen's width and height, to keep the card on it. */
  width: number
  height: number
  /** How many lines the words area shows: ANNOUNCER_LINES, or fewer where it does not fit. */
  lineCount?: number
  /** How much of the newest line shows: a rewind's words fade before they go. */
  lineOpacity?: number
  /**
   * `catcher`, the default: hung below the catcher's nameplate. `column`:
   * laid out in the flow of the side column that holds it, full width less
   * its margins, with no catcher.
   */
  placement?: 'catcher' | 'column'
  /**
   * How tall its lines are drawn: the screen's measured heights, or
   * `estimatedLineHeights()` by default.
   */
  lineHeights?: CardLineHeights
}

const CARD_WIDTH = 320
const MARGIN = 12
/**
 * Clears the catcher's nameplate, which hangs just below the figure: 24 to
 * its foot, and half a rem (8) more so the card's top never touches it.
 */
export const BELOW_NAMEPLATE = 24 + 16 / 2

/**
 * The replay's written play-by-play, in the scoring screen's brown and gold
 * card, just below the catcher, or at the top of the box score's column.
 */
export function ReplayPlayCard(
  props: ReplayPlayCardProps
): React.ReactElement | null {
  const theme = useTheme()
  // Only the tail's ref and its growth and layout handlers: nobody scrolls
  // the words, so its following never stops here.
  const tail = useTailFollow()
  const { onContentSizeChange: handleGrowth, onLayout: handleLayout } =
    tail.scrollProps
  // Each new sentence scrolls to the end itself, once its key is drawn: the
  // primary path. A new sentence can be as tall as the one it pushes out, so
  // the words do not grow, and a browser anchors the view to the lines that
  // stay, above the new one; growth alone would leave it there. Growth and
  // layout then cover what is laid out after that: a sentence that wraps to
  // another line, the area resized, and on a phone, where layout comes after
  // the effect, the new sentence's own height. That second scroll goes to
  // the same end the first is already moving to, so it retargets the one
  // smooth scroll rather than starting another, and the reader sees one.
  const newest = props.lines.at(-1)?.key
  React.useEffect(() => {
    if (newest != null) tail.ref.current?.scrollToEnd({ animated: true })
  }, [newest, tail.ref])
  const lineCount = props.lineCount ?? ANNOUNCER_LINES
  const heights = props.lineHeights ?? estimatedLineHeights()
  const column = props.placement === 'column'
  const { catcher } = props
  const shown = column || (catcher != null && props.width > 0)
  const width = Math.min(CARD_WIDTH, props.width - MARGIN * 2)
  // Below the catcher, kept 12 above the screen's bottom.
  const top =
    column || catcher == null
      ? null
      : Math.min(
          catcher.y + catcher.height + BELOW_NAMEPLATE,
          props.height - MARGIN - cardHeightOf(lineCount, heights)
        )
  if (!shown) return null
  // In the column's flow, or hung below the catcher.
  const place: ViewStyle =
    top == null || catcher == null
      ? { marginHorizontal: MARGIN }
      : {
          position: 'absolute',
          top,
          left: Math.max(
            MARGIN,
            Math.min(
              props.width - MARGIN - width,
              catcher.x + catcher.width / 2 - width / 2
            )
          ),
          width
        }
  return (
    <View
      pointerEvents="none"
      testID="replay-play-card"
      accessibilityLiveRegion="polite"
      style={{
        ...place,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: CARD_BORDER,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        paddingHorizontal: 12,
        paddingVertical: CARD_PADDING,
        gap: CARD_GAP
      }}
    >
      <ScrollView
        ref={tail.ref}
        testID="replay-play-card-words"
        // Only a new sentence, growth and layout move it. Nobody scrolls it,
        // and a browser shifting the offset as old lines drop off is not a
        // reader scrolling up, so its scroll events must not stop the
        // following.
        onContentSizeChange={handleGrowth}
        onLayout={handleLayout}
        scrollEnabled={false}
        pointerEvents="none"
        showsVerticalScrollIndicator={false}
        style={{
          height: lineCount * heights.words,
          flexGrow: 0
        }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}
      >
        {props.lines.map((entry, index) => {
          const newest = index === props.lines.length - 1
          return (
            <Text
              key={entry.key}
              testID={newest ? 'replay-play-card-line' : undefined}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={{
                ...wordsStyle(theme),
                opacity: newest ? (props.lineOpacity ?? 1) : 1
              }}
            >
              {entry.text}
            </Text>
          )
        })}
      </ScrollView>
      {props.detail === '' ? (
        <View style={{ height: heights.detail }} />
      ) : (
        <DetailLine id="replay-play-card-detail" detail={props.detail} />
      )}
    </View>
  )
}

/** The card's detail line, in its own style: the situation, or "Paused". */
function DetailLine(props: {
  /** Its Text's testID. */
  id: string
  detail: string
}): React.ReactElement {
  const theme = useTheme()
  return (
    <Text
      testID={props.id}
      numberOfLines={1}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      style={detailStyle(theme)}
    >
      {props.detail}
    </Text>
  )
}

/**
 * The card's detail alone, in the card's brown and gold: what a reader must
 * see where no card fits, "Announcer unavailable" or "Paused", at the top of
 * the deck. `detailStripHeight(heights)` tall.
 */
export function ReplayDetailStrip(props: {
  detail: string
}): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      pointerEvents="none"
      testID="replay-deck-detail"
      accessibilityLiveRegion="polite"
      style={{
        marginHorizontal: MARGIN,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: CARD_BORDER,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        paddingHorizontal: 12,
        paddingVertical: STRIP_PADDING
      }}
    >
      <DetailLine id="replay-deck-detail-text" detail={props.detail} />
    </View>
  )
}
