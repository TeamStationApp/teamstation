import React, { useEffect, useRef, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'

import { tsLogoSource } from '../assets'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { readPicked } from './chatFiles'
import type { ChatDropTargetProps } from './chatFileTypes'

/** A single stable file-only overlay for this open conversation's pane. */
export function ChatDropTarget(props: ChatDropTargetProps): React.ReactElement {
  const target = useRef<React.ComponentRef<typeof View>>(null)
  const latest = useRef(props)
  latest.current = props
  const [active, setActive] = useState(false)
  const theme = useTheme()
  useEffect(() => {
    const pane = target.current
    if (!(pane instanceof HTMLElement)) return
    let depth = 0
    const clear = (): void => {
      depth = 0
      setActive(false)
    }
    const filesOnly = (event: DragEvent): boolean =>
      event.dataTransfer != null &&
      (Array.from(event.dataTransfer.types).includes('Files') ||
        Array.from(event.dataTransfer.items).some(
          item => item.kind === 'file'
        ) ||
        event.dataTransfer.files.length > 0)
    const enter = (event: DragEvent): void => {
      if (!filesOnly(event)) return
      event.preventDefault()
      depth += 1
      setActive(true)
    }
    const over = (event: DragEvent): void => {
      if (!filesOnly(event)) return
      event.preventDefault()
      if (event.dataTransfer != null) event.dataTransfer.dropEffect = 'copy'
      setActive(true)
    }
    const leave = (event: DragEvent): void => {
      depth = Math.max(0, depth - 1)
      if (
        event.relatedTarget instanceof Node &&
        pane.contains(event.relatedTarget)
      )
        return
      const bounds = pane.getBoundingClientRect()
      if (
        depth === 0 ||
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        clear()
    }
    const drop = (event: DragEvent): void => {
      if (!filesOnly(event)) {
        clear()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clear()
      const files = Array.from(event.dataTransfer!.files)
      const current = latest.current
      if (current.disabledReason != null)
        current.onReject(current.disabledReason)
      else
        current.onPrepare(
          async remaining => await readPicked(files, undefined, remaining)
        )
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clear()
    }
    pane.addEventListener('dragenter', enter)
    pane.addEventListener('dragover', over)
    pane.addEventListener('dragleave', leave)
    pane.addEventListener('drop', drop)
    window.addEventListener('dragend', clear)
    window.addEventListener('blur', clear)
    window.addEventListener('keydown', key)
    return () => {
      pane.removeEventListener('dragenter', enter)
      pane.removeEventListener('dragover', over)
      pane.removeEventListener('dragleave', leave)
      pane.removeEventListener('drop', drop)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('blur', clear)
      window.removeEventListener('keydown', key)
    }
  }, [])
  return (
    <View
      ref={target}
      testID="chat-drop-target"
      style={{ flex: 1, minHeight: 0 }}
    >
      {props.children}
      {active && (
        <View
          pointerEvents="none"
          testID="chat-drop-overlay"
          accessibilityLiveRegion="polite"
          style={[
            StyleSheet.absoluteFill,
            {
              zIndex: 20,
              backgroundColor: 'rgba(255,255,255,0.82)',
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.rem(1)
            }
          ]}
        >
          <Image
            source={tsLogoSource}
            accessibilityLabel="TeamStation"
            style={{ width: theme.rem(4), height: theme.rem(4) }}
          />
          <Text
            style={{
              color: '#1d301b',
              fontFamily: theme.semiBoldTextFont,
              fontSize: theme.rem(1.25)
            }}
          >
            {lstrings.chat_attaching_file}
          </Text>
        </View>
      )}
    </View>
  )
}
