import React from 'react'

import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { richColorsOf, richDocument } from './richDocument'

export interface RichFrameProps {
  html: string
  /** Scrolls and takes touches; a card's preview does neither. */
  interactive: boolean
}

/**
 * A reply's table or chart in a sandboxed frame with no permissions at all:
 * no scripts, no same origin, no navigation of the app. The document's own
 * policy stops it fetching anything.
 */
export function RichFrame({
  html,
  interactive
}: RichFrameProps): React.ReactElement {
  const theme = useTheme()
  return (
    <iframe
      title={lstrings.tess_rich_title}
      sandbox=""
      srcDoc={richDocument(html, richColorsOf(theme))}
      tabIndex={interactive ? 0 : -1}
      style={{
        border: 0,
        width: '100%',
        height: '100%',
        display: 'block',
        pointerEvents: interactive ? 'auto' : 'none'
      }}
    />
  )
}
