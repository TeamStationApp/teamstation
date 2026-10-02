import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { GuidanceDetail } from './GuidanceDetail'
import { CORRECTION_WINDOW_MS } from './scoringTypes'
export const CORRECTION_INSTRUCTION =
  'Drag any other runners to advance them or have them called out'
export interface ScoreboardBounds {
  x: number
  y: number
  width: number
  height: number
}
export function InstructionToast({
  instruction,
  detail,
  status,
  finishLabel = 'Finish at-bat',
  remainingMs,
  canFinish = false,
  onFinish,
  bounds,
  compact = false,
  minTop = 62,
  below = 0
}: {
  instruction?: string
  detail?: string
  status?: string
  finishLabel?: string
  remainingMs?: number
  canFinish?: boolean
  onFinish?: () => void
  bounds?: ScoreboardBounds
  compact?: boolean
  /** The highest the toast may start, clear of ☰: 62 on the web. */
  minTop?: number
  /** Keeps the toast below whatever sits above it — the dictation log. */
  below?: number
}): React.ReactElement | null {
  const theme = useTheme()
  if (instruction == null && remainingMs == null && onFinish == null)
    return null
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: Math.max(
          below,
          compact ? (bounds?.y ?? 8) : Math.max(minTop, bounds?.y ?? 75)
        ),
        left: bounds?.x ?? 12,
        right: bounds == null ? 12 : undefined,
        width: bounds?.width,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        padding: compact ? 8 : 12,
        gap: compact ? 6 : 10
      }}
    >
      <Text
        pointerEvents="none"
        accessibilityLiveRegion="polite"
        style={{
          fontFamily: theme.semiBoldTextFont,
          color: theme.scoringInstructionText,
          fontSize: 16
        }}
      >
        {instruction ?? CORRECTION_INSTRUCTION}
      </Text>
      {[
        { label: 'Home run type', value: status },
        { label: 'Ball trajectory', value: detail }
      ]
        .filter(item => item.value != null)
        .map(item => (
          <GuidanceDetail
            key={item.label}
            label={item.label}
            value={item.value!}
          />
        ))}
      {(remainingMs != null || onFinish != null) && (
        <View
          pointerEvents="box-none"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          {remainingMs != null && (
            <>
              <Text
                pointerEvents="none"
                accessibilityLabel="Seconds to edit play"
                style={{
                  color: theme.scoringInstructionText,
                  fontFamily: theme.boldTextFont,
                  fontSize: 18,
                  minWidth: 24
                }}
              >
                {Math.ceil(remainingMs / 1000)}
              </Text>
              <View
                pointerEvents="none"
                accessibilityRole="progressbar"
                accessibilityLabel="Time to edit play"
                aria-valuemin={0}
                aria-valuemax={CORRECTION_WINDOW_MS / 1000}
                aria-valuenow={Math.ceil(remainingMs / 1000)}
                style={{ flex: 1, height: 5 }}
              >
                <View
                  style={{
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: theme.scoringCountdownColor,
                    width: `${Math.max(0, Math.min(100, (remainingMs / CORRECTION_WINDOW_MS) * 100))}%`
                  }}
                />
              </View>
            </>
          )}
          {remainingMs == null && <View style={{ flex: 1 }} />}
          <Pressable
            accessibilityLabel={finishLabel}
            accessibilityRole="button"
            disabled={!canFinish}
            onPress={onFinish}
            style={{
              backgroundColor: theme.scoringSafeColor,
              minHeight: 44,
              paddingHorizontal: 16,
              borderRadius: theme.rem(theme.radiusRem),
              justifyContent: 'center',
              opacity: canFinish ? 1 : 0.5
            }}
          >
            <Text
              selectable={false}
              style={{
                color: theme.scoringDecisionText,
                fontFamily: theme.semiBoldTextFont
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}
