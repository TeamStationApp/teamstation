import React, { useLayoutEffect, useRef, useState } from 'react'
import { Animated, Platform, Text, View } from 'react-native'

import type { ScoringFrame } from '../field/scoringFrame'
import { type HeldGameControl, PARKED_GAME_MESSAGE } from '../sync/useOffline'
import { useTheme } from '../theme/ThemeContext'
import { HeldGameNotice } from './HeldGameNotice'
import { NOTICE_TEXT_AREA } from './scoringControlStyle'
import type { ScoringNotice } from './scoringNotice'

const LINE_HEIGHT = 16
const DEFAULT_SIZE = 13
const MIN_SIZE = 11

/** Measure an unclamped copy with the real font and line wrapping. */
export function useFittedNoticeFont(
  text: string,
  width: number,
  family: string
): number {
  const [size, setSize] = useState(DEFAULT_SIZE)
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || text === '' || width <= 0) return
    const probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    Object.assign(probe.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
      width: `${width}px`,
      lineHeight: `${LINE_HEIGHT}px`,
      fontFamily: family,
      overflowWrap: 'anywhere',
      whiteSpace: 'pre-wrap'
    })
    probe.textContent = text
    document.body.appendChild(probe)
    try {
      for (let candidate = DEFAULT_SIZE; candidate >= MIN_SIZE; candidate--) {
        probe.style.fontSize = `${candidate}px`
        if (
          probe.scrollHeight <= LINE_HEIGHT * 2 &&
          probe.scrollWidth <= width
        ) {
          setSize(candidate)
          return
        }
      }
      setSize(0)
    } finally {
      probe.remove()
    }
  }, [text, width, family])
  return size
}

function shortDetail(notice: ScoringNotice): string {
  if (notice.kind === 'held')
    return notice.text === PARKED_GAME_MESSAGE
      ? 'Game changed on the server. Your edits are held here.'
      : 'Edits not sent. Tap for details.'
  if (notice.text.startsWith('Not saved:'))
    return 'The server could not save these changes.'
  return 'A queued game update was reported.'
}

function NoticeText({
  notice,
  compact,
  width
}: {
  notice: ScoringNotice
  compact?: string
  width: number
}): React.ReactElement {
  const theme = useTheme()
  const candidate = compact ?? notice.text
  const availableWidth = Math.max(1, width - 16)
  const webSize = useFittedNoticeFont(
    candidate,
    availableWidth,
    theme.regularTextFont
  )
  const [nativeSize, setNativeSize] = useState(DEFAULT_SIZE)
  const fit = Platform.OS === 'web' ? webSize : nativeSize
  const fontSize = fit === 0 ? DEFAULT_SIZE : fit
  const content = fit === 0 ? shortDetail(notice) : candidate
  const style = {
    fontFamily: theme.regularTextFont,
    lineHeight: LINE_HEIGHT,
    color: theme.scoringNoticeText
  }
  return (
    <View
      style={{
        height: NOTICE_TEXT_AREA,
        justifyContent: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4
      }}
    >
      {Platform.OS !== 'web' && nativeSize > 0 && (
        <Text
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            ...style,
            fontSize: nativeSize,
            width: availableWidth,
            position: 'absolute',
            opacity: 0
          }}
          onTextLayout={event => {
            if (
              event.nativeEvent.lines.length > 2 ||
              event.nativeEvent.lines.some(line => line.width > availableWidth)
            )
              setNativeSize(nativeSize > MIN_SIZE ? nativeSize - 1 : 0)
          }}
        >
          {candidate}
        </Text>
      )}
      <Text
        testID={
          notice.text === 'Saving…' || notice.text.startsWith('Not saved:')
            ? 'scoringSaveStatus'
            : undefined
        }
        accessibilityLabel={notice.text}
        numberOfLines={2}
        adjustsFontSizeToFit={Platform.OS !== 'web'}
        minimumFontScale={MIN_SIZE / fontSize}
        style={{ ...style, fontSize, textAlign: 'center' }}
      >
        {content}
      </Text>
    </View>
  )
}

interface Display {
  notice: ScoringNotice
  compact?: string
}

export function ScoringNoticeBar({
  frame,
  reducedMotion,
  notice,
  compact,
  held,
  onSettled
}: {
  frame: Pick<ScoringFrame, 'stripHeight' | 'stripTop' | 'fieldWidth'>
  reducedMotion: boolean
  notice: ScoringNotice | null
  compact?: string
  held?: HeldGameControl
  onSettled: (arrived: boolean) => void
}): React.ReactElement | null {
  const theme = useTheme()
  const { stripHeight, stripTop, fieldWidth } = frame
  // Progress, rather than pixels, keeps an in-flight slide flush on rotation.
  const [progress] = useState(() => new Animated.Value(1))
  const [exiting, setExiting] = useState<Display>()
  const shown = notice != null
  const last = useRef<Display | undefined>(undefined)
  useLayoutEffect(() => {
    if (notice != null) last.current = { notice, compact }
  }, [notice, compact])
  useLayoutEffect(() => {
    if (!shown && !reducedMotion) setExiting(last.current)
    if (reducedMotion || (!shown && last.current == null)) {
      progress.setValue(shown ? 0 : 1)
      setExiting(undefined)
      if (!shown) last.current = undefined
      return
    }
    const slide = Animated.timing(progress, {
      toValue: shown ? 0 : 1,
      duration: 200,
      useNativeDriver: Platform.OS !== 'web'
    })
    slide.start(({ finished }) => {
      if (finished && !shown) {
        last.current = undefined
        setExiting(undefined)
      }
    })
    return () => {
      slide.stop()
    }
  }, [progress, reducedMotion, shown])
  const current = notice != null ? { notice, compact } : exiting
  if (current == null) return null
  const button = notice?.kind === 'held' && held != null
  const label = (
    <NoticeText
      key={`${fieldWidth}:${current.compact ?? current.notice.text}`}
      {...current}
      width={fieldWidth}
    />
  )
  return (
    <Animated.View
      testID={notice?.kind === 'report' ? 'scoringNotice' : undefined}
      pointerEvents={button ? 'box-none' : 'none'}
      accessibilityLiveRegion={notice?.kind === 'report' ? 'polite' : undefined}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      style={{
        position: 'absolute',
        left: 0,
        width: fieldWidth,
        top: stripTop,
        height: stripHeight,
        zIndex: 150,
        overflow: 'hidden',
        backgroundColor: theme.scoringNoticeFill,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [0, stripHeight]
            })
          }
        ]
      }}
    >
      {button ? (
        <HeldGameNotice
          fill
          held={held}
          onSettled={onSettled}
          testID="heldGameMessage"
        >
          {label}
        </HeldGameNotice>
      ) : (
        label
      )}
    </Animated.View>
  )
}
