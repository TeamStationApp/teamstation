import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ScoringMenuIcon } from './ScoringMenuIcon'
import type { MenuIconKind } from './scoringMenuIcons'

export const SCORING_MENU = {
  background: 'rgba(18, 28, 23, 0.95)',
  border: 'rgba(16, 185, 129, 0.4)',
  divider: 'rgba(6, 78, 59, 0.5)',
  text: '#e2e8f0',
  active: '#1d6b42',
  activeEnd: '#165835',
  accent: '#34d399',
  bottom: 144,
  rowHeight: 44,
  outPanelHeight: 160
} as const

const badgeColors = {
  green: { text: '#6ee7b7', background: '#10b98133', border: '#10b9814d' },
  amber: { text: '#fcd34d', background: '#f59e0b33', border: '#f59e0b4d' },
  red: { text: '#fca5a5', background: '#450a0acc', border: '#991b1b99' }
} as const
const decorations: Record<
  string,
  { badge: string; tone: keyof typeof badgeColors } | { icon: MenuIconKind }
> = {
  'Batter Out': { badge: 'OUT', tone: 'red' },
  Single: { badge: '1B', tone: 'green' },
  Double: { badge: '2B', tone: 'green' },
  Triple: { badge: '3B', tone: 'green' },
  'Home Run': { badge: 'HR', tone: 'green' },
  "Fielder's Choice": { badge: 'FC', tone: 'amber' },
  Error: { badge: 'E', tone: 'amber' },
  'Throw Out': { icon: 'throw' },
  'Ball Caught': { icon: 'catch' },
  'Batter Interference': { icon: 'interference' },
  Balk: { badge: 'BK', tone: 'amber' },
  'Put Batter on Base': { badge: 'OB', tone: 'green' },
  'Batter Out — Other': { badge: 'OUT', tone: 'red' },
  'Place a Runner (Tiebreaker)': { badge: 'TB', tone: 'green' },
  'Hit by Pitch': { badge: 'HBP', tone: 'green' },
  'Intentional Walk': { badge: 'IBB', tone: 'green' },
  "Catcher's Interference": { badge: 'CI', tone: 'amber' },
  'Dropped Third Strike': { badge: 'D3S', tone: 'red' },
  First: { badge: '1B', tone: 'green' },
  Second: { badge: '2B', tone: 'green' },
  Third: { badge: '3B', tone: 'green' }
}

/** Presentation only: the calling menu owns the available actions and handlers. */
export function ScoringMenuLabel({
  label,
  active = false,
  chevron,
  danger = false
}: {
  label: string
  active?: boolean
  chevron?: 'left' | 'right'
  danger?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const decoration = decorations[label]
  const colors =
    decoration != null && 'badge' in decoration
      ? badgeColors[decoration.tone]
      : undefined
  return (
    <View
      pointerEvents="none"
      style={{
        // Grow and shrink from the text's own width, never from zero: the
        // scoring menu takes its width from its rows, and a phone's Yoga
        // would otherwise lay every row, and the menu, out 26 points wide.
        flexGrow: 1,
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6
      }}
    >
      {chevron === 'left' && (
        <Text
          selectable={false}
          style={{
            color: active ? '#a7f3d0' : '#a3a3a3',
            fontSize: 17,
            lineHeight: 18
          }}
        >
          ‹
        </Text>
      )}
      <Text
        testID="scoring-menu-label"
        selectable={false}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          textAlign: 'left',
          fontFamily: theme.regularTextFont,
          fontSize: 13,
          lineHeight: 18,
          fontWeight: '700',
          letterSpacing: 0.2,
          color: danger ? '#f87171' : active ? '#ffffff' : SCORING_MENU.text
        }}
      >
        {label === 'Place a Runner (Tiebreaker)' ? (
          <>
            {lstrings.scoring_place_runner}
            {'\n'}
            <Text style={{ color: '#cbd5e1', fontSize: 11, fontWeight: '500' }}>
              {lstrings.scoring_tiebreaker}
            </Text>
          </>
        ) : (
          label
        )}
      </Text>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
      >
        {active && label === 'Batter Out' ? (
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: '#6ee7b7',
              shadowColor: '#34d399',
              shadowOpacity: 1,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 0 }
            }}
          />
        ) : decoration != null && 'icon' in decoration ? (
          <ScoringMenuIcon
            kind={decoration.icon}
            color={active ? '#6ee7b7' : '#a3a3a3'}
          />
        ) : decoration != null && 'badge' in decoration && colors != null ? (
          <View
            style={{
              borderRadius: 4,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.background,
              paddingHorizontal: 5,
              paddingVertical: 2
            }}
          >
            <Text
              selectable={false}
              style={{
                fontFamily: 'monospace',
                fontSize: 10,
                lineHeight: 13,
                fontWeight: '700',
                color: colors.text
              }}
            >
              {decoration.badge}
            </Text>
          </View>
        ) : null}
        {chevron === 'right' && (
          <Text
            selectable={false}
            style={{ color: active ? '#a7f3d0' : '#a3a3a3', fontSize: 17 }}
          >
            ›
          </Text>
        )}
      </View>
    </View>
  )
}

export function OutTypeHeader(): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      pointerEvents="none"
      style={{
        height: 26,
        paddingHorizontal: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#172720',
        borderBottomWidth: 1,
        borderBottomColor: SCORING_MENU.border
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: SCORING_MENU.accent
          }}
        />
        <Text
          style={{
            fontFamily: theme.regularTextFont,
            color: SCORING_MENU.accent,
            fontSize: 9,
            fontWeight: '800',
            letterSpacing: 0.8
          }}
        >
          {lstrings.scoring_out_type}
        </Text>
      </View>
      <Text
        style={{
          fontFamily: theme.regularTextFont,
          fontSize: 9,
          color: '#a3a3a3',
          fontWeight: '600'
        }}
      >
        {lstrings.scoring_submenu}
      </Text>
    </View>
  )
}

/** Native menu adapter shares the same labels, badges, and selection colors. */
export function ScoringMenuButton({
  label,
  disabled = false,
  submenuRight = false,
  submenuLeft = false,
  danger = false,
  highlighted = false,
  onPress
}: {
  label: string
  disabled?: boolean
  submenuRight?: boolean
  /** The submenu opens to the left, as Batter Out's does. */
  submenuLeft?: boolean
  danger?: boolean
  /** Lit by a drag passing over it, which the row cannot see for itself. */
  highlighted?: boolean
  onPress: () => void
}): React.ReactElement {
  const [pressed, setActive] = useState(false)
  const active = pressed || highlighted
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => {
        setActive(true)
      }}
      onHoverOut={() => {
        setActive(false)
      }}
      onFocus={() => {
        setActive(true)
      }}
      onBlur={() => {
        setActive(false)
      }}
      onPressIn={() => {
        setActive(true)
      }}
      onPressOut={() => {
        setActive(false)
      }}
      style={{
        minHeight: SCORING_MENU.rowHeight,
        paddingHorizontal: 10,
        paddingVertical: 9,
        borderBottomWidth: 1,
        borderBottomColor: SCORING_MENU.divider,
        backgroundColor:
          active && !disabled ? SCORING_MENU.active : SCORING_MENU.background,
        opacity: disabled ? 0.4 : 1
      }}
    >
      <ScoringMenuLabel
        label={label}
        danger={danger}
        active={active && !disabled}
        chevron={submenuRight ? 'right' : submenuLeft ? 'left' : undefined}
      />
    </Pressable>
  )
}
