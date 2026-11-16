import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import type { PlanSyncCard } from './planInning'

/**
 * The card dropped from the top of the scoring screen when an inning's plan
 * column could not be downloaded: it names the team, and offers Accept,
 * which keeps the lineup the game has, and Try again, which asks once more.
 * One card at a time, the away side's first.
 */
export function PlanSyncNotice({
  cards,
  onRetry,
  onAccept,
  top = 62
}: {
  cards: readonly PlanSyncCard[]
  onRetry: (card: PlanSyncCard) => void
  onAccept: (card: PlanSyncCard) => void
  /** Where the card starts, clear of ☰. */
  top?: number
}): React.ReactElement | null {
  const theme = useTheme()
  const card =
    cards.find(each => each.side === 'away') ??
    cards.find(each => each.side === 'home')
  if (card == null) return null
  return (
    <View
      testID="planSyncNotice"
      // The card takes every touch on it: nothing under it is reached.
      pointerEvents="auto"
      style={{
        position: 'absolute',
        top,
        left: 12,
        right: 12,
        zIndex: 99,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        padding: 12,
        gap: 10
      }}
    >
      <Text
        accessibilityLiveRegion="polite"
        style={{
          fontFamily: theme.semiBoldTextFont,
          color: theme.scoringInstructionText,
          fontSize: 16
        }}
      >
        {sprintf(lstrings.scoring_plan_sync_failed, card.teamName)}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 12
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.scoring_plan_sync_accept}
          onPress={() => {
            onAccept(card)
          }}
          style={{
            minHeight: 44,
            justifyContent: 'center',
            paddingHorizontal: 8
          }}
        >
          <Text
            style={{
              color: theme.scoringInstructionText,
              fontFamily: theme.semiBoldTextFont
            }}
          >
            {lstrings.scoring_plan_sync_accept}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.scoring_plan_sync_retry}
          onPress={() => {
            onRetry(card)
          }}
          style={{
            minHeight: 44,
            paddingHorizontal: 16,
            borderRadius: theme.rem(theme.radiusRem),
            backgroundColor: theme.scoringSafeColor,
            justifyContent: 'center'
          }}
        >
          <Text
            style={{
              color: theme.scoringDecisionText,
              fontFamily: theme.semiBoldTextFont
            }}
          >
            {lstrings.scoring_plan_sync_retry}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
