import type React from 'react'
import type { ViewProps } from 'react-native'

/**
 * A pane of glass, shared by all three implementations.
 *
 * In a third module because a native sibling cannot import from its own web
 * twin — Metro resolves the import back to the sibling itself.
 */
export interface GlassViewProps extends ViewProps {
  children?: React.ReactNode
  /**
   * Fill it in instead of seeing through it.
   *
   * For somebody who has asked for less transparency. A translucent bar over
   * an unblurred photograph of a ball field is unreadable, which is worse than
   * a plain one.
   */
  opaque?: boolean
  /**
   * Let it respond to a finger, the way the system's own bars do.
   *
   * For the tab capsule, which is pressed; not for the header, which is not.
   * iOS 26 only — it is what makes the glass deform under a touch.
   */
  interactive?: boolean
  /** The corner the glass is cut to, in points. A capsule asks for its half. */
  radius?: number
  /**
   * The more transparent of iOS 26's two glass styles.
   *
   * `clear` refracts what passes under it far more obviously than `regular`,
   * which is the point of asking for glass rather than a blur. It is not the
   * default, because `regular` is the safer one where text sits directly on
   * the material — a title on the header has to stay readable over whatever
   * happens to scroll beneath it, and a row of icons does not.
   *
   * iOS 26 only. Everything else ignores it.
   */
  clear?: boolean
  /**
   * Draw nothing at all where real glass is not available.
   *
   * For a surface that is *already* sitting on glass — the row of
   * destinations inside the header. Real glass over glass is the effect that
   * was asked for on iOS and it is worth having; the fallback tint over glass
   * is not the same thing at all. On Android it came out as a square-cornered
   * box around the three icons, where the browser draws a blur over an
   * already-uniform header and you cannot see it at all.
   *
   * So: iOS keeps its glass, and everything that cannot draw glass draws
   * nothing, which is what the browser effectively does.
   */
  fallbackFill?: boolean
}
