// Measured on a 393-point native host on iOS 27.2. The 83-point UITabBar
// includes the home-indicator space. The material itself occupies 62 points.
//
// The selected highlight is as tall as the platter less NAV_PILL_PAD at each
// edge, and as wide as UIKit's tab button under it. UIKit overlaps neighbouring
// buttons by NAV_HIGHLIGHT_OVERLAP, so each is wider than its fifth of the
// platter. Once that would leave the buttons NAV_HIGHLIGHT_ROOMY_STEP or more
// apart at NAV_HIGHLIGHT_MIN_WIDTH each, it switches to the smaller
// NAV_HIGHLIGHT_ROOMY_OVERLAP and no narrower than NAV_HIGHLIGHT_MIN_WIDTH.
// NAV_LABEL_INSET is the gap from the highlight's bottom to its label's.
// TabBarViewTests checks these against the rendered UIKit bar.
import dimensions from './tabBarDimensions.json'

export const {
  NAV_SIDE_INSET,
  NAV_BOTTOM_GAP,
  NAV_HEIGHT,
  NAV_NATIVE_HEIGHT_ABOVE_INSET,
  NAV_COMPACT_WIDTH,
  NAV_COMPACT_HEIGHT,
  NAV_PILL_PAD,
  NAV_HIGHLIGHT_OVERLAP,
  NAV_HIGHLIGHT_ROOMY_STEP,
  NAV_HIGHLIGHT_ROOMY_OVERLAP,
  NAV_HIGHLIGHT_MIN_WIDTH,
  NAV_LABEL_INSET
} = dimensions
