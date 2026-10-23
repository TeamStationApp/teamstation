import React from 'react'
import { WebView } from 'react-native-webview'

import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { richColorsOf, richDocument } from './richDocument'

export interface RichFrameProps {
  html: string
  /** Scrolls and takes touches; a card's preview does neither. */
  interactive: boolean
}

/** The document the HTML source loads as; any other address is a navigation. */
const INITIAL_DOCUMENT = 'about:blank'

/**
 * The phone's frame: a WebView with JavaScript off that loads the document
 * and nothing after it. A tapped link inside a table goes nowhere.
 */
export function RichFrame({
  html,
  interactive
}: RichFrameProps): React.ReactElement {
  const theme = useTheme()
  return (
    <WebView
      accessibilityLabel={lstrings.tess_rich_title}
      source={{ html: richDocument(html, richColorsOf(theme)) }}
      originWhitelist={['about:*']}
      javaScriptEnabled={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      setSupportMultipleWindows={false}
      // A list, not a bare "none": only the iOS WebView wraps a bare value,
      // and Android's props parser reads it as a list and crashes the app.
      dataDetectorTypes={['none']}
      scrollEnabled={interactive}
      pointerEvents={interactive ? 'auto' : 'none'}
      style={{ flex: 1, backgroundColor: 'transparent' }}
      onShouldStartLoadWithRequest={request => request.url === INITIAL_DOCUMENT}
    />
  )
}
