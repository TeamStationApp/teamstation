import { useEffect, useRef } from 'react'
import { BackHandler } from 'react-native'

/**
 * While Tess's chat covers the app, Android's Back closes it and does
 * nothing else. Added when the chat opens, after the address bar's own
 * listener, so it is asked first; removed when the chat closes. iOS has no
 * system Back, and the chat's X is its way out.
 */
export function useTessBack(active: boolean, close: () => void): void {
  const closing = useRef(close)
  closing.current = close
  useEffect(() => {
    if (!active) return
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      closing.current()
      return true
    })
    return () => {
      back.remove()
    }
  }, [active])
}
