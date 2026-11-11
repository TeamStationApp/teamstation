import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { RosterCandidate } from '../../common/api'
import { ButtonIcon } from '../components/ButtonIcon'
import { PersonAffiliationLine } from '../components/PersonAffiliationLine'
import { PersonEmblem } from '../components/PersonEmblem'
import { useScoringSheetTheme } from './scoringSheetTheme'

/**
 * One search result in scoring colours: the player's picture or initials,
 * their name, the affiliation line under it (`PersonAffiliationLine`), and a
 * chevron.
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
      <PersonEmblem
        userId={candidate.userId}
        name={candidate.shortName}
        uri={candidate.avatarUrl}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
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
        <PersonAffiliationLine
          affiliations={candidate.affiliations}
          color={surface.secondaryText}
          testID="Candidate affiliations"
        />
      </View>
      <ButtonIcon name="chevron_right">
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
      </ButtonIcon>
    </Pressable>
  )
}
