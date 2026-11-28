import React from 'react'
import { View, type ViewStyle } from 'react-native'

import {
  type ContentInset,
  ContentInsetContext,
  NO_INSET
} from '../components/contentInset'
import { CardBand, PillBand } from '../components/PinnedBands'
import type { PinnedHead } from '../components/pinnedHead'
import { columnSpace, useColumnSide } from '../components/Screen'
import { type Theme, useTheme } from '../theme/ThemeContext'

/**
 * The game's hero card and section pills on Videos: the same bands as the
 * other sections draw them in. Shared by the browser's watch layout and the
 * phone's.
 *
 * Upright they sit at the `Screen` column's margins, in a column with its top
 * padding and gaps (`uprightColumn`), so a change of pill between Videos and
 * Info or Box Score moves neither. Held sideways there is no hero, and the
 * pills sit flat above the picture. Both bands are drawn either way, so
 * turning the phone keeps the same views.
 *
 * They are the column's own children, as in `Screen`, never wrapped: a
 * browser holds a `sticky` band only within its parent, and a wrapper as tall
 * as the bands would let them scroll away. They span the column and carry
 * its margin inside them, which `scrollerInset` (what the layout's scroller
 * already pads its content by: the phone's side insets) is taken off.
 */
export function GameWatchHead(props: {
  pinned: PinnedHead
  head: React.ReactNode
  sections: React.ReactNode
  short: boolean
  scrollerInset?: ContentInset
}): React.ReactElement {
  const { pinned, head, sections, short, scrollerInset = NO_INSET } = props
  const theme = useTheme()
  const column = useColumnSide()
  const side = short
    ? {
        left: theme.rem(theme.spaceMdRem),
        right: theme.rem(theme.spaceMdRem)
      }
    : {
        left: column.left - scrollerInset.left,
        right: column.right - scrollerInset.right
      }
  const padded = { paddingLeft: side.left, paddingRight: side.right }
  return (
    <ContentInsetContext.Provider value={NO_INSET}>
      <CardBand part={pinned.cardBand} flat={short}>
        <View style={short ? undefined : padded}>{short ? null : head}</View>
      </CardBand>
      <PillBand part={pinned.pillBand} flat={short} testID="event-pill-band">
        <View style={padded}>
          {/* The pill strip runs out through that margin to the edge. */}
          <ContentInsetContext.Provider value={side}>
            {sections}
          </ContentInsetContext.Provider>
        </View>
      </PillBand>
    </ContentInsetContext.Provider>
  )
}

/**
 * The column the watch layout's head sits in when upright: the `Screen`
 * column's top padding and gaps, which the bands reach over and take back as
 * they do there.
 */
export function uprightColumn(theme: Theme): ViewStyle {
  return { paddingTop: columnSpace(theme), gap: columnSpace(theme) }
}
