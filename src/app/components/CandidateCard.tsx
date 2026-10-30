import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { RosterCandidate } from '../../common/api'
import { useTheme } from '../theme/ThemeContext'
import { Emblem } from './Emblem'
import { Icon } from './Icon'
import { initialsOf } from './initials'

/** A pill's height; its padding is at least half of it (`docs/ui-rules.md`). */
const PILL_HEIGHT = 22

/**
 * One search result in the app theme, a card of its own: the player's
 * picture or initials, their short name, a pill for each team they play for
 * in a current or future season, and a chevron.
 */
export function CandidateCard({
  candidate,
  onPress
}: {
  candidate: RosterCandidate
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Choose ${candidate.shortName}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 64,
        marginBottom: theme.rem(0.5),
        paddingHorizontal: theme.rem(0.75),
        paddingVertical: theme.rem(0.625),
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.rem(0.75),
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 1,
        borderColor: theme.defaultBorderColor,
        backgroundColor: pressed
          ? theme.containerBackgroundColor
          : theme.cardBackgroundColor,
        shadowColor: '#000000',
        shadowOpacity: 0.06,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
        elevation: 1
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
            color: theme.primaryTextColor,
            fontFamily: theme.semiBoldTextFont,
            fontSize: theme.rem(1)
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
                  backgroundColor: theme.pillBackground
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.pillTextColor,
                    fontFamily: theme.regularTextFont,
                    fontSize: theme.rem(0.75)
                  }}
                >
                  {team.name}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
      <Icon name="chevron_right" color={theme.secondaryTextColor} />
    </Pressable>
  )
}
