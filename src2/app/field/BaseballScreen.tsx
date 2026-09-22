import React, { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { NAV_CLEARANCE_REM, useBreakpoint, useHeaderSlot } from '../components'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { FieldCanvas } from './FieldCanvas'
import {
  type CameraView,
  createPlayers,
  nextBase,
  setDestination
} from './fieldModel'
import { fieldPalette as p } from './fieldPalette'

export function BaseballScreen(): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const phone = useBreakpoint() === 'phone'
  const { headerHeight } = useHeaderSlot()
  const insets = useInsets()
  const [players, setPlayers] = useState(createPlayers)
  const [selected, setSelected] = useState('SS')
  const [view, setView] = useState<CameraView>('home')
  const [zoom, setZoom] = useState(1)
  const [movementRevision, setMovementRevision] = useState(0)
  const player = players.find(item => item.id === selected) ?? players[0]
  const button = (
    label: string,
    action: () => void,
    active = false,
    accessibilityLabel = label
  ): React.ReactElement => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      onPress={action}
      style={({ pressed }) => [
        styles.button,
        active && styles.activeButton,
        pressed && { opacity: 0.65 }
      ]}
    >
      <Text style={[styles.buttonText, active && styles.activeText]}>
        {label}
      </Text>
    </Pressable>
  )
  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: headerHeight,
          paddingBottom: phone
            ? theme.rem(NAV_CLEARANCE_REM) + insets.bottom
            : 16
        }
      ]}
    >
      <View style={styles.intro}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>THE SANDBOX / 01</Text>
          <Text style={[styles.title, phone && { fontSize: 24 }]}>
            Your field. Your play.
          </Text>
          <Text style={styles.subtitle}>Drag a player. Watch them run.</Text>
        </View>
        {button('Reset', () => {
          setPlayers(createPlayers())
          setSelected('SS')
          setView('home')
          setZoom(1)
        })}
      </View>
      <View style={styles.viewport}>
        <FieldCanvas
          players={players}
          selected={selected}
          onSelect={setSelected}
          view={view}
          zoom={zoom}
          movementRevision={movementRevision}
        />
        <View pointerEvents="none" style={styles.sceneBadge}>
          <Text style={styles.sceneBadgeText}>FIELD LAB · EXHIBITION</Text>
        </View>
        <View style={{ position: 'absolute', top: 12, right: 12 }}>
          {button(
            'Board',
            () => {
              setView(view === 'scoreboard' ? 'home' : 'scoreboard')
              setZoom(1)
            },
            view === 'scoreboard',
            'Scoreboard camera'
          )}
        </View>
        <View style={styles.cameraBar}>
          {button(
            'Home',
            () => {
              setView('home')
            },
            view === 'home',
            'Home plate camera'
          )}
          {button(
            'Above',
            () => {
              setView('overhead')
            },
            view === 'overhead',
            'Overhead camera'
          )}
          {button(
            'Infield',
            () => {
              setView('infield')
            },
            view === 'infield',
            'Infield camera'
          )}
          {button(
            '−',
            () => {
              setZoom(value => Math.max(0.7, value - 0.15))
            },
            false,
            'Zoom out'
          )}
          {button(
            '+',
            () => {
              setZoom(value => Math.min(1.8, value + 0.15))
            },
            false,
            'Zoom in'
          )}
        </View>
      </View>
      <View style={styles.controls}>
        <View style={styles.controlHeading}>
          <Text style={styles.playerName} accessibilityLiveRegion="polite">
            {player.name}
          </Text>
          <Text style={styles.legend}>9 fielders · 3 runners</Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.roster}
        >
          {players.map(item => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Select ${item.name.toLowerCase()}`}
              accessibilityState={{ selected: selected === item.id }}
              onPress={() => {
                setSelected(item.id)
              }}
              style={[
                styles.playerButton,
                selected === item.id && styles.selectedPlayer
              ]}
            >
              <View
                style={[
                  styles.teamDot,
                  {
                    backgroundColor:
                      item.team === 'runner' ? p.runner : p.defense
                  }
                ]}
              />
              <Text style={styles.buttonText}>{item.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.actionRow}>
          <Text style={[styles.hint, { flex: 1 }]}>
            {phone
              ? 'Select, then tap the turf to move.'
              : 'Drag on the field, or select a player and click a destination.'}
          </Text>
          {player.team === 'runner'
            ? button('Next base →', () => {
                setDestination(player, nextBase(player))
                setMovementRevision(value => value + 1)
              })
            : button('Run a play →', () => {
                setMovementRevision(value => value + 1)
                players.forEach(item => {
                  if (item.team === 'runner')
                    setDestination(item, nextBase(item))
                })
              })}
        </View>
      </View>
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  root: { flex: 1, backgroundColor: theme.backgroundColor },
  intro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16
  },
  eyebrow: {
    color: theme.secondaryTextColor,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 5
  },
  title: {
    color: theme.primaryTextColor,
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -1
  },
  subtitle: { color: theme.secondaryTextColor, fontSize: 13, marginTop: 5 },
  viewport: {
    flex: 1,
    minHeight: 240,
    overflow: 'hidden',
    borderRadius: 18,
    marginHorizontal: 12,
    backgroundColor: p.sky
  },
  sceneBadge: {
    position: 'absolute',
    top: 14,
    left: 14,
    borderRadius: 6,
    backgroundColor: theme.scoreboardBackground,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  sceneBadgeText: {
    color: theme.scoreboardTextColor,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2
  },
  cameraBar: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: 12,
    backgroundColor: theme.cardBackgroundColor
  },
  button: {
    minHeight: 40,
    minWidth: 36,
    paddingHorizontal: 11,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: theme.containerBackgroundColor
  },
  buttonText: {
    color: theme.primaryTextColor,
    fontSize: 12,
    fontWeight: '600'
  },
  activeButton: { backgroundColor: theme.primaryButtonColor },
  activeText: { color: theme.buttonTextColor },
  controls: { paddingHorizontal: 20, paddingTop: 12, gap: 10 },
  controlHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  playerName: {
    color: theme.primaryTextColor,
    fontSize: 15,
    fontWeight: '700'
  },
  legend: { color: theme.secondaryTextColor, fontSize: 11 },
  roster: { gap: 6, paddingVertical: 2 },
  playerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minWidth: 48,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    borderRadius: 8
  },
  selectedPlayer: {
    borderColor: theme.primaryTextColor,
    backgroundColor: theme.containerBackgroundColor
  },
  teamDot: { width: 7, height: 7, borderRadius: 4 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hint: { color: theme.secondaryTextColor, fontSize: 11, lineHeight: 16 }
}))
