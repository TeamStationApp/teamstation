import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { ScoringSession } from '../../common/scoring/session'
import { ButtonIcon } from '../components/ButtonIcon'
import { GlassView } from '../components/GlassView'
import { useTheme } from '../theme/ThemeContext'
import {
  dismissRemoteLog,
  nextRemoteLog,
  type RemoteLogRow,
  type RemoteLogState,
  startRemoteLog
} from './remoteLog'
import { LOG_HEADER, LOG_LINE } from './scoringControlStyle'
import { scoringPreferences } from './scoringPreferences'

export interface RemoteScoringUpdatesProps {
  game: ScoringSession
  userId: string
  placement?: 'stacked' | 'column'
  frame: { top: number; left: number; width: number; lines: number }
  /** Keep collecting updates while a scoring menu or sheet is in use. */
  obscured?: boolean
}

function ControlBlur({ id }: { id: string }): React.ReactElement {
  return (
    <GlassView
      pointerEvents="none"
      subtleBlur
      androidBlur
      radius={8}
      testID={id}
      style={{
        position: 'absolute',
        inset: 4,
        borderRadius: 8,
        overflow: 'hidden'
      }}
    />
  )
}

/** An information card, not a modal: scoring continues outside its bounds. */
export function RemoteScoringUpdates(
  props: RemoteScoringUpdatesProps
): React.ReactElement | null {
  const theme = useTheme()
  const [entries, setEntries] = useState<readonly RemoteLogRow[]>([])
  const [visible, setVisible] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const following = useRef(true)
  const lastOffset = useRef(0)
  const [paused, setPaused] = useState(false)
  const mountScroll = useCallback(
    (view: React.ComponentRef<typeof ScrollView> | null): void => {
      scroll.current = view
      if (view == null) return
      following.current = true
      lastOffset.current = 0
      setPaused(false)
      view.scrollToEnd({ animated: false })
    },
    []
  )
  const follow = (): void => {
    if (following.current) scroll.current?.scrollToEnd({ animated: true })
  }
  const preferenceEdits = useRef(0)
  useEffect(() => {
    let active = true
    const version = preferenceEdits.current
    scoringPreferences
      .read(props.userId)
      .then(value => {
        if (active && preferenceEdits.current === version)
          setCollapsed(value.remoteUpdatesCollapsed === true)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [props.userId])
  const log = useRef<RemoteLogState | undefined>(undefined)
  useEffect(() => {
    // What the game already holds when the panel opens is the baseline.
    const opened = startRemoteLog(props.game.accepted, props.userId)
    log.current = opened
    following.current = true
    lastOffset.current = 0
    setPaused(false)
    setEntries([])
    setVisible(false)
    let seen = props.game.accepted
    const unsubscribe = props.game.subscribe(() => {
      const accepted = props.game.accepted
      // Only a newly confirmed history can change a row; local, unsaved
      // scoring never reaches `accepted`.
      if (accepted === seen) return
      seen = accepted
      const before = new Set(opened.rows.map(row => row.id))
      const { changed } = nextRemoteLog(opened, accepted)
      if (!changed) return
      setEntries(opened.rows)
      if (opened.rows.some(row => !before.has(row.id))) setVisible(true)
    })
    return () => {
      unsubscribe()
      log.current = undefined
    }
  }, [props.game, props.userId])
  if (
    !visible ||
    props.obscured === true ||
    entries.length === 0 ||
    props.frame.lines < 1 ||
    props.frame.width <= 0
  )
    return null
  const { top, left, lines } = props.frame
  const column = props.placement === 'column'
  const visibleLines = column
    ? Math.min(
        lines,
        entries.reduce((total, row) => total + row.lines.length, 0)
      )
    : lines
  const width =
    collapsed && !column ? Math.min(96, props.frame.width) : props.frame.width
  return (
    <View
      testID="remote-scoring-updates"
      style={{
        position: column ? 'relative' : 'absolute',
        flexShrink: 0,
        zIndex: 10,
        elevation: 10,
        top,
        left: left + (props.frame.width - width) / 2,
        width: column ? '100%' : width,
        borderRadius: theme.rem(theme.radiusRem),
        backgroundColor: theme.scoringInstructionBackground,
        overflow: 'hidden'
      }}
    >
      <View
        pointerEvents="box-none"
        testID="remote-scoring-update-controls"
        style={{
          position: 'relative',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1,
          height: LOG_HEADER,
          flexDirection: 'row',
          justifyContent: 'space-between'
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            collapsed ? 'Expand scoring updates' : 'Collapse scoring updates'
          }
          onPress={() => {
            const next = !collapsed
            following.current = true
            lastOffset.current = 0
            setPaused(false)
            preferenceEdits.current++
            setCollapsed(next)
            scoringPreferences
              .update(props.userId, stored => ({
                ...stored,
                remoteUpdatesCollapsed: next
              }))
              .catch(() => undefined)
          }}
          style={{
            width: 44,
            height: LOG_HEADER,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <ControlBlur id="remote-scoring-collapse-blur" />
          <View
            style={{ transform: [{ rotate: collapsed ? '90deg' : '-90deg' }] }}
          >
            <ButtonIcon
              name="chevron_right"
              size={1.5}
              color={theme.scoringInstructionText}
            />
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss scoring updates"
          onPress={() => {
            setVisible(false)
            setEntries([])
            if (log.current != null)
              dismissRemoteLog(log.current, props.game.accepted)
          }}
          style={{
            width: 44,
            height: LOG_HEADER,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <ControlBlur id="remote-scoring-dismiss-blur" />
          <ButtonIcon
            name="close"
            size={1.5}
            color={theme.scoringInstructionText}
          />
        </Pressable>
      </View>
      {!collapsed && (
        <ScrollView
          ref={mountScroll}
          testID="remote-scoring-update-lines"
          onContentSizeChange={follow}
          onLayout={follow}
          scrollEventThrottle={16}
          onScroll={event => {
            const { contentOffset, contentSize, layoutMeasurement } =
              event.nativeEvent
            const y = contentOffset.y
            // Allow for fractional native scroll offsets and bottom overscroll.
            const atBottom =
              y + layoutMeasurement.height >= contentSize.height - 2
            if (atBottom) {
              following.current = true
              setPaused(false)
            }
            // Covers mouse-wheel scrolling on web as well as native drags.
            else if (y < lastOffset.current - 1) {
              following.current = false
              setPaused(true)
            }
            lastOffset.current = y
          }}
          style={{ height: visibleLines * LOG_LINE, flexGrow: 0 }}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'flex-end',
            paddingLeft: 10,
            paddingRight: 10,
            paddingBottom: 0
          }}
          nestedScrollEnabled
        >
          {entries.map(update =>
            update.lines.map((line, index) => (
              <Text
                key={`${update.id}:${index}`}
                style={{
                  fontFamily: theme.regularTextFont,
                  fontSize: 15,
                  lineHeight: LOG_LINE,
                  color: theme.scoringInstructionText
                }}
              >
                <Text
                  style={{
                    fontFamily: theme.semiBoldTextFont,
                    color: theme.scoringCountdownColor
                  }}
                >
                  {update.name}:{' '}
                </Text>
                {line}
              </Text>
            ))
          )}
        </ScrollView>
      )}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          inset: 0,
          borderWidth: 2,
          borderColor: theme.scoringInstructionBorder,
          borderRadius: theme.rem(theme.radiusRem)
        }}
      />
      {!collapsed && paused && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Follow latest scoring updates"
          onPress={() => {
            following.current = true
            setPaused(false)
            scroll.current?.scrollToEnd({ animated: true })
          }}
          style={{
            position: 'absolute',
            right: 2,
            bottom: 2,
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8
          }}
        >
          <ControlBlur id="remote-scoring-follow-blur" />
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              borderWidth: 2,
              borderColor: theme.scoringInstructionText,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ rotate: '90deg' }]
            }}
          >
            <ButtonIcon
              name="chevron_right"
              size={1.4}
              color={theme.scoringInstructionText}
            />
          </View>
        </Pressable>
      )}
    </View>
  )
}
