import React, { useRef, useState } from 'react'
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { NAV_CLEARANCE_REM, useBreakpoint, useHeaderSlot } from '../components'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { ArcMode, BallArcState } from './ballArcModel'
import { CameraDragControl } from './CameraDragControl'
import { fieldViewportHeight } from './cameraModel'
import { FieldCanvas } from './FieldCanvas'
import {
  type CameraView,
  createPlayers,
  nextBase,
  setDestination
} from './fieldModel'
import { fieldPalette as p } from './fieldPalette'

export function BaseballScreen(): React.ReactElement {
  const screen = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const theme = useTheme()
  const styles = getStyles(theme)
  const phone = useBreakpoint() === 'phone'
  const { headerHeight } = useHeaderSlot()
  const insets = useInsets()
  const [players, setPlayers] = useState(createPlayers)
  const [selected, setSelected] = useState('SS')
  const [view, setView] = useState<CameraView>('home')
  const [arc, setArc] = useState<BallArcState | null>(null)
  const [arcMode, setArcMode] = useState<ArcMode>('off')
  const [zoom, setZoom] = useState(1)
  const [cameraTilt, setCameraTilt] = useState(0)
  const [cameraHeight, setCameraHeight] = useState(0)
  const [cameraDragging, setCameraDragging] = useState(false)
  const { width: windowWidth } = useWindowDimensions()
  const viewportHeight = fieldViewportHeight(windowWidth - 24)
  const selectView = (next: CameraView): void => {
    setView(next)
    setCameraTilt(0)
    setCameraHeight(0)
  }
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
    <ScrollView
      ref={screen}
      scrollEnabled={!cameraDragging}
      style={{ flex: 1, backgroundColor: theme.backgroundColor }}
      contentContainerStyle={[
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
          <Text style={styles.subtitle}>Plan a move. Release to run.</Text>
        </View>
        {button('Reset', () => {
          setPlayers(createPlayers())
          setSelected('SS')
          selectView('home')
          setZoom(1)
          setArc(null)
          setArcMode('off')
        })}
      </View>
      <View style={[styles.viewport, { height: viewportHeight }]}>
        <FieldCanvas
          arc={arc}
          arcMode={arcMode}
          onArcChange={setArc}
          onArcFinish={() => {
            setArcMode('edit')
          }}
          players={players}
          selected={selected}
          onSelect={setSelected}
          view={view}
          zoom={zoom}
          cameraTilt={cameraTilt}
          cameraHeight={cameraHeight}
          movementRevision={movementRevision}
        />
        <View pointerEvents="none" style={styles.sceneBadge}>
          <Text style={styles.sceneBadgeText}>FIELD LAB · EXHIBITION</Text>
        </View>
        <View style={{ position: 'absolute', top: 12, right: 12 }}>
          {button(
            'Board',
            () => {
              setArcMode('off')
              selectView(view === 'scoreboard' ? 'home' : 'scoreboard')
              setZoom(1)
            },
            view === 'scoreboard',
            'Scoreboard camera'
          )}
        </View>
        <View style={{ position: 'absolute', right: 12, bottom: 12, gap: 8 }}>
          <CameraDragControl
            kind="zoom"
            value={zoom}
            onChange={setZoom}
            onActive={setCameraDragging}
          />
          <CameraDragControl
            kind="tilt"
            value={cameraTilt}
            onChange={setCameraTilt}
            onActive={setCameraDragging}
          />
          <CameraDragControl
            kind="height"
            value={cameraHeight}
            onChange={setCameraHeight}
            onActive={setCameraDragging}
          />
        </View>
        {arcMode !== 'off' && (
          <View style={{ position: 'absolute', top: 52, right: 12 }}>
            {button(
              'Done',
              () => {
                setArcMode('off')
              },
              false,
              'Finish ball arc'
            )}
          </View>
        )}
        {arcMode !== 'off' && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 52,
              left: 12,
              right: 90,
              backgroundColor: theme.cardBackgroundColor,
              borderRadius: 8,
              padding: 8
            }}
          >
            <Text style={styles.buttonText}>
              {arcMode === 'aim'
                ? 'Tap or drag a landing point'
                : `Drag arrows up / down · ${arc != null && arc.angle < 0 ? 'Chopper' : `${Math.round(arc?.angle ?? 30)}°`}`}
            </Text>
          </View>
        )}
        <View style={styles.cameraBar}>
          {button(
            'Home',
            () => {
              selectView('home')
            },
            view === 'home',
            'Home plate camera'
          )}
          {button(
            'Above',
            () => {
              selectView('overhead')
            },
            view === 'overhead',
            'Overhead camera'
          )}
          {button(
            'Infield',
            () => {
              selectView('infield')
            },
            view === 'infield',
            'Infield camera'
          )}
        </View>
      </View>
      <View style={styles.controls}>
        <View style={{ gap: 8, marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {button(
              arcMode === 'off' ? 'Ball arc ↗' : 'Move landing',
              () => {
                if (view === 'scoreboard') {
                  selectView('home')
                  setZoom(1)
                }
                setArcMode('aim')
                screen.current?.scrollTo({ y: 0, animated: true })
              },
              arcMode === 'aim'
            )}
            {arc != null &&
              arcMode === 'off' &&
              button('Adjust arc', () => {
                setArcMode('edit')
              })}
            {arcMode !== 'off' &&
              button('Done', () => {
                setArcMode('off')
              })}
            {arc != null &&
              button('Clear arc', () => {
                setArc(null)
                setArcMode('off')
              })}
          </View>
          <Text style={styles.hint} accessibilityLiveRegion="polite">
            {arcMode === 'aim'
              ? 'Tap or drag the field to set the landing point.'
              : arcMode === 'edit'
                ? 'Drag near the yellow arrows: up for a fly ball, down for a chopper.'
                : 'Draw a hit from home plate with Ball arc.'}
            {arc != null
              ? `  ${arc.angle < 0 ? 'Chopper' : `${Math.round(arc.angle)}° launch`} · ${Math.round(Math.hypot(arc.target.x, arc.target.z))}m`
              : ''}
          </Text>
        </View>
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
              ? 'Drag a player or name; release to move.'
              : 'Drag a player or name to preview a move; release to run.'}
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
    </ScrollView>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  root: { flexGrow: 1, backgroundColor: theme.backgroundColor },
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
    flexShrink: 0,
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
    left: 12,
    flexDirection: 'column',
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
