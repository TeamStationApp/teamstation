import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { RosterCandidate } from '../../common/api'
import { Emblem } from '../components/Emblem'
import { initialsOf } from '../components/initials'
import { useScoringSheetTheme } from './scoringSheetTheme'

/** A pill's height; its padding is at least half of it (`docs/ui-rules.md`). */
const PILL_HEIGHT = 22

/**
 * One search result in scoring colours: the player's picture or initials,
 * their short name, a pill for each team they play for in a current or
 * future season, and a chevron.
 */
export function ScoringCandidateCard({
  candidate,
  disabled = false,
  onPress
}: {
  candidate: RosterCandidate
  disabled?: boolean
  onPress: () => void
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const surface = theme.scoringSurface
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Choose ${candidate.shortName}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 64,
        marginBottom: 8,
        paddingHorizontal: 10,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: surface.divider,
        backgroundColor: pressed ? surface.active : surface.idle,
        opacity: disabled ? 0.4 : 1
      })}
    >
      <Emblem
        shape="circle"
        uri={candidate.avatarUrl}
        fallback={initialsOf(candidate.shortName)}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <Text
          numberOfLines={1}
          style={{
            color: surface.text,
            fontFamily: theme.semiBoldTextFont,
            fontSize: 15
          }}
        >
          {candidate.shortName}
        </Text>
        {candidate.teams.length > 0 && (
          <View
            testID="Candidate teams"
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}
          >
            {candidate.teams.map(team => (
              <View
                key={team.teamId}
                style={{
                  height: PILL_HEIGHT,
                  paddingHorizontal: PILL_HEIGHT / 2,
                  maxWidth: '100%',
                  justifyContent: 'center',
                  borderRadius: PILL_HEIGHT / 2,
                  borderWidth: 1,
                  borderColor: surface.badges.green.border,
                  backgroundColor: surface.badges.green.background
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: surface.badges.green.text,
                    fontFamily: theme.regularTextFont,
                    fontSize: 12
                  }}
                >
                  {team.name}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
      <Text
        style={{
          fontSize: 22,
          paddingRight: 4,
          color: surface.chevronActive,
          fontFamily: theme.regularTextFont
        }}
      >
        ›
      </Text>
    </Pressable>
  )
}
