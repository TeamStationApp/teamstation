import React, { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { ScoringSession } from '../../common/scoring/session'
import type { ScoringUpdate } from '../../common/scoring/updates'
import { ButtonIcon } from '../components/ButtonIcon'
import type { ScreenRect } from '../field/catcherBounds'
import { useTheme } from '../theme/ThemeContext'
import { scoringPreferences } from './scoringPreferences'

export interface RemoteScoringUpdatesProps {
  game: ScoringSession
  userId: string
  catcher: ScreenRect | null
  width: number
  height: number
  undoWidth: number
  /** Top of the Undo row, leaving room for the collapsed control. */
  undoTop: number
  /** Keep collecting updates while a scoring menu or sheet is in use. */
  obscured?: boolean
}

/** An information card, not a modal: scoring continues outside its bounds. */
export function RemoteScoringUpdates(
  props: RemoteScoringUpdatesProps
): React.ReactElement | null {
  const theme = useTheme()
  const [entries, setEntries] = useState<readonly ScoringUpdate[]>([])
  const [visible, setVisible] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
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
  useEffect(() => {
    // The first read is the baseline, including a cached game's known stream.
    const seen = new Set(props.game.scoringUpdates.map(update => update.id))
    setEntries([])
    setVisible(false)
    return props.game.subscribe(() => {
      const fresh = props.game.scoringUpdates.filter(
        update => !seen.has(update.id)
      )
      for (const update of fresh) seen.add(update.id)
      const external = fresh.filter(update => update.userId !== props.userId)
      if (external.length === 0) return
      setEntries(previous => [...previous, ...external].slice(-100))
      setVisible(true)
    })
  }, [props.game, props.userId])
  if (
    !visible ||
    props.obscured === true ||
    entries.length === 0 ||
    props.catcher == null ||
    props.width === 0
  )
    return null
  const width = collapsed ? Math.min(96, props.undoWidth) : props.width - 24
  const headerHeight = 44
  const desiredTop = props.catcher.y + props.catcher.height + 24
  const top = Math.max(
    8,
    Math.min(
      desiredTop,
      collapsed ? props.undoTop - headerHeight - 4 : props.height - 88
    )
  )
  // Keep the anchor beneath home plate, shortening the scrollable body when
  // browser chrome leaves less room. Twelve points clear the bottom edge.
  const bodyHeight = Math.min(100, Math.max(20, props.height - top - 68))
  const center = props.catcher.x + props.catcher.width / 2
  return (
    <View
      testID="remote-scoring-updates"
      style={{
        position: 'absolute',
        top,
        left: Math.max(
          12,
          Math.min(props.width - width - 12, center - width / 2)
        ),
        width,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        overflow: 'hidden'
      }}
    >
      <View
        style={{
          height: headerHeight,
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
            height: headerHeight,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
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
          }}
          style={{
            width: 44,
            height: headerHeight,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <ButtonIcon
            name="close"
            size={1.5}
            color={theme.scoringInstructionText}
          />
        </Pressable>
      </View>
      {!collapsed && (
        <ScrollView
          testID="remote-scoring-update-lines"
          style={{ maxHeight: bodyHeight }}
          contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 8 }}
          nestedScrollEnabled
        >
          {entries.map(update => (
            <View key={update.id}>
              <Text
                style={{
                  fontFamily: theme.semiBoldTextFont,
                  fontSize: 15,
                  lineHeight: 20,
                  color: theme.scoringInstructionText
                }}
              >
                {update.name === '' ? 'Another scorer' : update.name}
              </Text>
              {update.lines.map((line, index) => (
                <Text
                  key={index}
                  style={{
                    fontFamily: theme.regularTextFont,
                    fontSize: 15,
                    lineHeight: 20,
                    color: theme.scoringInstructionText
                  }}
                >
                  {line}
                </Text>
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  )
}
