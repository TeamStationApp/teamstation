import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { BaseProjection } from '../field/fieldTypes'
import { defensiveRosterLabel, defensiveRosterName } from './currentSetup'
import { RosterSelector } from './RosterSelector'
import { ScoringPlayerCard } from './ScoringPlayerCard'
import { ScoringError, ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'
import type { ScoringSessionState } from './scoringTypes'
import { recentRunnerIds } from './tiebreaker'

export function TiebreakerSetupSheet({
  outs,
  onPlace,
  onOuts,
  onClose,
  problem
}: {
  outs: number
  onPlace: () => void
  onOuts: (outs: number) => void
  onClose: () => void
  problem?: string
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const text = {
    color: theme.scoringSurface.text,
    fontFamily: theme.semiBoldTextFont,
    fontSize: 16
  }
  const row = {
    minHeight: 64,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.scoringSurface.divider,
    paddingVertical: 10
  }
  return (
    <ScoringSheet title="Place a Runner (Tiebreaker)" onClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Place runner on base"
        onPress={onPlace}
        style={row}
      >
        <Text style={{ ...text, flex: 1 }}>Place runner on base</Text>
        <Text style={{ ...text, color: theme.scoringSurface.chevronActive }}>
          ›
        </Text>
      </Pressable>
      <View style={row}>
        <View style={{ width: 192 }}>
          <RosterSelector
            labels={['0', '1', '2']}
            labelPrefix="Set Outs"
            value={outs}
            onChange={onOuts}
          />
        </View>
        <Text style={text}>Set Outs</Text>
      </View>
      <ScoringError message={problem} />
    </ScoringSheet>
  )
}

export function RunnerRosterSheet({
  session,
  base,
  onChoose,
  onClose,
  problem
}: {
  session: ScoringSessionState
  base: number
  onChoose: (id: number) => void
  onClose: () => void
  problem?: string
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const candidates = recentRunnerIds(session)
  return (
    <ScoringSheet title={`Select Runner for ${base}B`} onClose={onClose}>
      <View style={{ gap: 12 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: theme.scoringSurface.text,
            fontFamily: theme.boldTextFont,
            fontSize: 16
          }}
        >
          Recently Batted Players
        </Text>
        <ScoringError message={problem} />
        {candidates.length === 0 && (
          <Text style={{ color: theme.scoringSurface.text }}>
            No eligible players in the batting order.
          </Text>
        )}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {candidates.map(id => {
            const player = session.gameData.players[id]
            const jersey = player.jersey.trim()
            return (
              <ScoringPlayerCard
                key={id}
                width="48%"
                label={`Select runner ${defensiveRosterLabel(player)}`}
                name={`${defensiveRosterName(player)}${jersey === '' ? '' : ` #${jersey}`}`}
                onPress={() => {
                  onChoose(id)
                }}
              />
            )
          })}
        </View>
      </View>
    </ScoringSheet>
  )
}

/** Native views and web views use the same camera-projected base coordinates. */
export function TiebreakerBases({
  projection,
  occupied,
  onChoose,
  onCancel
}: {
  projection?: BaseProjection
  occupied: ReadonlyArray<number | null>
  onChoose: (base: number) => void
  onCancel: () => void
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const target = theme.scoringSurface.baseTarget
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', inset: 0 }}>
      {[1, 2, 3].map(base => {
        const point = projection?.bases[base]
        if (point == null) return null
        const disabled = occupied[base - 1] != null
        return (
          <Pressable
            key={base}
            accessibilityRole="button"
            accessibilityLabel={`Place runner on ${base}B`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => {
              onChoose(base)
            }}
            style={{
              position: 'absolute',
              left: Math.max(0, Math.min(projection!.width - 56, point.x - 28)),
              top: Math.max(0, Math.min(projection!.height - 48, point.y - 24)),
              width: 56,
              height: 48,
              borderWidth: 2,
              borderStyle: 'dashed',
              borderColor: target.border,
              backgroundColor: target.background,
              borderRadius: 6,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: disabled ? 0.4 : 1
            }}
          >
            <Text
              style={{
                color: target.text,
                fontFamily: theme.boldTextFont,
                fontSize: 18
              }}
            >
              {base}B
            </Text>
          </Pressable>
        )
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel runner placement"
        onPress={onCancel}
        style={{
          position: 'absolute',
          bottom: 140,
          alignSelf: 'center',
          minHeight: 44,
          paddingHorizontal: 24,
          justifyContent: 'center'
        }}
      >
        <Text
          style={{
            color: theme.scoringSurface.danger,
            fontFamily: theme.semiBoldTextFont,
            fontSize: 16
          }}
        >
          Cancel
        </Text>
      </Pressable>
    </View>
  )
}
