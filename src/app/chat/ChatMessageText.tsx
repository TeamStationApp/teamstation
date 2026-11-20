import React, { useMemo } from 'react'
import { Platform, Text, type TextStyle } from 'react-native'

import type { MessagePressGesture } from './chatInteractionModel'
import { chatLinkAddress, chatLinkSpans } from './chatMessageLinks'

interface Props {
  body: string
  style: TextStyle
  selectable: boolean
  gesture?: MessagePressGesture
  onOpen?: (address: string) => void
}

export function ChatMessageText(props: Props): React.ReactElement {
  const { body, onOpen, gesture } = props
  const links = useMemo(() => chatLinkSpans(body), [body])
  const children: React.ReactNode[] = []
  let offset = 0
  for (const link of links) {
    children.push(body.slice(offset, link.start))
    children.push(
      <Text
        key={link.start}
        style={{ textDecorationLine: 'underline' }}
        {...(onOpen == null
          ? {}
          : {
              ...gesture?.pressProps,
              ...(Platform.OS === 'web' && {
                href: chatLinkAddress(link.text)?.href,
                hrefAttrs: { rel: 'noopener noreferrer', target: '_blank' }
              }),
              accessibilityRole: 'link' as const,
              tabIndex: 0 as const,
              onPress: event => {
                if (gesture?.canOpen(event) === false) {
                  event.preventDefault()
                  return
                }
                if (Platform.OS === 'web') {
                  const click = event.nativeEvent as {
                    metaKey?: boolean
                    ctrlKey?: boolean
                    shiftKey?: boolean
                    altKey?: boolean
                  }
                  if (
                    click.metaKey === true ||
                    click.ctrlKey === true ||
                    click.shiftKey === true ||
                    click.altKey === true
                  )
                    return
                }
                event.preventDefault()
                onOpen(link.text)
              }
            })}
      >
        {link.text}
      </Text>
    )
    offset = link.end
  }
  children.push(body.slice(offset))
  return (
    <Text style={props.style} selectable={props.selectable}>
      {children}
    </Text>
  )
}
