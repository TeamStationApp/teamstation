import { useSyncExternalStore } from 'react'
import { Dimensions } from 'react-native'

import { useTheme } from '../theme/ThemeContext'

export const SIDEBAR_WIDTH_REM = 16

function subscribe(changed: () => void): () => void {
  const listener = Dimensions.addEventListener('change', changed)
  return () => {
    listener.remove()
  }
}

/** Navigation uses the whole window, even while Tess shares the content pane. */
export function useSidebarWidth(): number {
  const theme = useTheme()
  const wide = useSyncExternalStore(
    subscribe,
    () =>
      Dimensions.get('window').width >=
      theme.rem(theme.maxContentWidthRem + SIDEBAR_WIDTH_REM)
  )
  return wide ? theme.rem(SIDEBAR_WIDTH_REM) : 0
}
