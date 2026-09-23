import { useThree } from '@react-three/fiber'
import { useLayoutEffect } from 'react'

/**
 * Holds the scene at the field's size and pixel ratio while it draws into a
 * smaller view (`fieldRenderBox`). Fiber's native Canvas sets both from the
 * view it is in whenever it renders; this puts them back, so camera framing,
 * hit-testing and every position the scene reports are in the field's own
 * points, as in the browser.
 */
export function FieldRenderScale({
  width,
  height,
  ratio
}: {
  width: number
  height: number
  ratio: number
}): null {
  const size = useThree(state => state.size)
  const dpr = useThree(state => state.viewport.dpr)
  const setSize = useThree(state => state.setSize)
  const setDpr = useThree(state => state.setDpr)
  useLayoutEffect(() => {
    if (dpr !== ratio) setDpr(ratio)
    if (size.width !== width || size.height !== height)
      setSize(width, height, size.top, size.left)
  }, [size, dpr, width, height, ratio, setSize, setDpr])
  return null
}
