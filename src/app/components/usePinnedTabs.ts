import { useCallback, useLayoutEffect, useRef } from 'react'

import { HANDOFF_RAMP } from './handoff'
import { useHeaderSlot } from './headerSlot'
import type { PinnedHead } from './pinnedHead'
import { useScreenBottom } from './Screen'
import { useHandoff } from './useHandoff'
import { usePinnedHead } from './usePinnedHead'

/** The header's height and the hand-off measured against it, as one. */
export interface PinnedHandoff {
  headerHeight: number
  handoff: ReturnType<typeof useHandoff>
}

/**
 * The hand-off for a screen whose card goes under the header above pinned
 * pills: its `progress` is for the header's copy of the name, and the whole
 * of it goes to `usePinnedTabs`, which puts its `ref` on the card's band.
 * Called on its own because the header's copy is set up before the tab is
 * known.
 *
 * Measured on that band, whose lower edge is the pills' upper one, and
 * brought forward half the hand-off's ramp: the name has finished arriving
 * at the moment the pills pin, and stays while they are pinned.
 */
export function usePinnedHandoff(): PinnedHandoff {
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight + HANDOFF_RAMP / 2)
  return { headerHeight, handoff }
}

/**
 * A card that scrolls away under the header, pills pinned under it, and the
 * selected tab starting directly under the pills: `usePinnedHead`, wired to
 * the screen's hand-off and bottom margin.
 *
 * `selectTab` is for a pill being tapped, before the tab is set. Tapping the
 * pill already selected starts its tab again from where it starts. A tab that
 * changes any other way — the address on Back or Forward, a tab the viewer
 * may not see sent back to the first one — is selected here once it shows,
 * so it starts under the pills too, not at the scroll the last tab left.
 */
export function usePinnedTabs(options: {
  /** `usePinnedHandoff()`'s result, whole. */
  head: PinnedHandoff
  /** The content has loaded, so the first anchor may run. */
  ready: boolean
  /** The tab showing. */
  tab: string
  /** The tab anchors on `pinned.nextRow` rather than at its top. */
  anchorOnRow: boolean
}): { pinned: PinnedHead; selectTab: (tab: string) => void } {
  const { head, ready, tab, anchorOnRow } = options
  const { headerHeight, handoff } = head
  const pinned = usePinnedHead({
    headerHeight,
    ready,
    tab,
    anchorOnRow,
    // The screen's bottom margin below the space after the content: the page
    // can always scroll that much further.
    tail: useScreenBottom(),
    onScroll: handoff.handleScroll,
    cardRef: handoff.ref
  })
  const { select } = pinned

  const shown = useRef(tab)
  const tapped = useRef<string | undefined>(undefined)
  const selectTab = useCallback(
    (next: string): void => {
      if (next !== shown.current) tapped.current = next
      select(next)
    },
    [select]
  )
  useLayoutEffect(() => {
    if (shown.current === tab) return
    shown.current = tab
    const wasTapped = tapped.current === tab
    tapped.current = undefined
    if (!wasTapped) select(tab)
  }, [tab, select])

  return { pinned, selectTab }
}
