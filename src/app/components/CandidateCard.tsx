import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { RosterCandidate } from '../../common/api'
import { useTheme } from '../theme/ThemeContext'
import { ButtonIcon } from './ButtonIcon'
import { Emblem } from './Emblem'
import { initialsOf } from './initials'
import { PersonAffiliationLine } from './PersonAffiliationLine'

/**
 * One search result in the app theme, a card of its own: the player's
 * picture or initials, their name, the affiliation line under it
 * (`PersonAffiliationLine`), and a chevron.
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
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
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
        <PersonAffiliationLine
          affiliations={candidate.affiliations}
          testID="Candidate affiliations"
        />
      </View>
      <ButtonIcon name="chevron_right" color={theme.secondaryTextColor} />
    </Pressable>
  )
}
