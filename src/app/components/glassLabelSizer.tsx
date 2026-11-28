import React from 'react'
import { Platform, type StyleProp, Text, type TextStyle } from 'react-native'

/**
 * A glass tab's unseen sizing text, in one of its label's two faces.
 *
 * On a phone it is plain text, which the phone measures. In a browser the
 * text is drawn from an attribute by a `::before` rule rather than held as a
 * text node, so it takes its room in the label box while the tab's text is
 * still its label once: what a search of the page or a test reads.
 */
export function GlassLabelSizer(props: {
  text: string
  style: StyleProp<TextStyle>
}): React.ReactElement {
  if (Platform.OS !== 'web') {
    return (
      <Text selectable={false} style={props.style}>
        {props.text}
      </Text>
    )
  }
  installSizerRule()
  return (
    <Text
      selectable={false}
      style={props.style}
      dataSet={{ glassSizer: props.text }}
    />
  )
}

let installed = false

/** The browser's document, typed for this file alone: the phone has none. */
interface SizerDocument {
  createElement: (tag: 'style') => { textContent: string | null }
  head: { appendChild: (node: { textContent: string | null }) => unknown }
}

function installSizerRule(): void {
  const page = (globalThis as { document?: SizerDocument }).document
  if (installed || page == null) return
  installed = true
  const rule = page.createElement('style')
  rule.textContent =
    '[data-glass-sizer]::before{content:attr(data-glass-sizer)}'
  page.head.appendChild(rule)
}
