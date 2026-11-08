import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Platform, type Text, type TextProps, type View } from 'react-native'

type ViewNode = React.ComponentRef<typeof View>
type TextNode = React.ComponentRef<typeof Text>

/**
 * The scale that fits a one-line text of `natural` width, measured at full
 * size, into `room`: 1 when it fits, never below `minimum`. Rounded down to
 * a hundredth, with a point to spare, so the browser's rounding of the
 * shrunken text's width cannot ellipsize it again.
 */
export function fittedTextScale(
  natural: number,
  room: number,
  minimum: number
): number {
  if (natural <= 0 || room <= 0 || natural <= room) return 1
  return Math.max(minimum, Math.floor(((room - 1) / natural) * 100) / 100)
}

export interface FittedText {
  /** The box whose inner width the text must fit. */
  box: React.RefObject<ViewNode | null>
  /** The one-line text, drawn no wider than its content or the box. */
  text: React.RefObject<TextNode | null>
  /** The box's layout handler, on the web. */
  handleLayout?: () => void
  /** The share of its size the web draws the text at. */
  scale: number
  /** What the phone's text needs to shrink itself. */
  textProps: Pick<TextProps, 'adjustsFontSizeToFit' | 'minimumFontScale'>
}

/**
 * Shrinks a one-line text to fit its box whole, never below `minimum` of
 * its size, rather than ellipsize it; with no `minimum`, nothing shrinks.
 * The phone fits it itself. The web cannot: on each layout of the box, once
 * the fonts have loaded, and when `content` changes, the text's full width,
 * read at the size it is drawn, is set against the box's inner width.
 */
export function useFittedText(
  minimum: number | undefined,
  content: string
): FittedText {
  const box = useRef<ViewNode>(null)
  const text = useRef<TextNode>(null)
  const [scale, setScale] = useState(1)
  const onWeb = minimum != null && Platform.OS === 'web'
  const measure = (): void => {
    const outer = box.current as unknown as HTMLElement | null
    const inner = text.current as unknown as HTMLElement | null
    if (minimum == null || outer == null || inner == null) return
    const padding = getComputedStyle(outer)
    const room =
      outer.clientWidth -
      parseFloat(padding.paddingLeft) -
      parseFloat(padding.paddingRight)
    const drawn = inner.scrollWidth
    setScale(shown => fittedTextScale(drawn / shown, room, minimum))
  }
  const measured = useRef(measure)
  measured.current = measure
  useEffect(() => {
    if (!onWeb) return
    let current = true
    // A test page has no font set.
    const { fonts } = document as { fonts?: FontFaceSet }
    fonts?.ready.then(
      () => {
        if (current) measured.current()
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [onWeb])
  useLayoutEffect(() => {
    if (onWeb) measured.current()
  }, [onWeb, content])
  return {
    box,
    text,
    ...(onWeb ? { handleLayout: measure } : {}),
    scale: onWeb ? scale : 1,
    textProps:
      minimum != null && !onWeb
        ? { adjustsFontSizeToFit: true, minimumFontScale: minimum }
        : {}
  }
}
