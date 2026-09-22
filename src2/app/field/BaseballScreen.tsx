import React, { useState } from 'react'
import {
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View
} from 'react-native'

import type { ArcMode, BallArcState } from './ballArcModel'
import { CameraDragControl } from './CameraDragControl'
import { FieldCanvas } from './FieldCanvas'
import { createPlayers } from './fieldModel'
import { type PitchKind, recordPitch } from './pitchControls'
import { PitchIcon } from './PitchIcon'
import { DEMO_SCOREBOARD, type ScoreboardState } from './scoreboardModel'
import { glassStyle, useFieldSurface } from './useFieldSurface'

const DEFAULT_CAMERA = { zoom: 1.25, tilt: (-11 * Math.PI) / 180, height: 33 }

interface Snapshot {
  event: string
  scoreboard: ScoreboardState
  arc: BallArcState | null
}
const pitches: Array<{ kind: PitchKind; label: string }> = [
  { kind: 'ball', label: 'Ball' },
  { kind: 'called', label: 'Called Strike' },
  { kind: 'swing', label: 'Swing and Miss' },
  { kind: 'foul', label: 'Foul Ball' },
  { kind: 'play', label: 'Ball in Play' }
]
export function BaseballScreen({
  onExit
}: {
  onExit: () => void
}): React.ReactElement {
  const surface = useFieldSurface()
  const [players, setPlayers] = useState(createPlayers)
  const [selected, setSelected] = useState('SS')
  const [arc, setArc] = useState<BallArcState | null>(null)
  const [arcMode, setArcMode] = useState<ArcMode>('off')
  const [zoom, setZoom] = useState(DEFAULT_CAMERA.zoom)
  const [cameraTilt, setCameraTilt] = useState(DEFAULT_CAMERA.tilt)
  const [cameraHeight, setCameraHeight] = useState(DEFAULT_CAMERA.height)
  const [menu, setMenu] = useState<'main' | 'more' | null>(null)
  const [scoreboard, setScoreboard] = useState(DEMO_SCOREBOARD)
  const [history, setHistory] = useState<Snapshot[]>([])
  const undoEvent = history[history.length - 1]?.event
  const save = (event: string): void => {
    setHistory(items => [...items, { scoreboard, arc, event }])
  }
  const pitch = (kind: PitchKind): void => {
    save(pitches.find(item => item.kind === kind)?.label ?? 'Pitch')
    setScoreboard(recordPitch(scoreboard, kind))
    setMenu(null)
    setArcMode(kind === 'play' ? 'aim' : 'off')
  }
  const undo = (): void => {
    const previous = history[history.length - 1]
    if (previous == null) return
    setScoreboard(previous.scoreboard)
    setArc(previous.arc)
    setArcMode('off')
    setHistory(items => items.slice(0, -1))
  }
  const action = (label: string, onPress: () => void): React.ReactElement => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.menuItem}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  )
  return (
    <View style={[styles.root, surface.root]}>
      {Platform.OS !== 'web' && <StatusBar barStyle="light-content" />}
      <View style={StyleSheet.absoluteFill}>
        <FieldCanvas
          touchPlacement={Platform.OS !== 'web'}
          scoreboard={scoreboard}
          arc={arc}
          arcMode={arcMode}
          onArcChange={setArc}
          onArcFinish={() => {
            setArcMode('edit')
          }}
          players={players}
          selected={selected}
          onSelect={setSelected}
          view="home"
          zoom={zoom}
          cameraTilt={cameraTilt}
          cameraHeight={cameraHeight}
        />
      </View>
      <View
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, surface.safe]}
      >
        <View pointerEvents="box-none" style={styles.header}>
          <View style={{ width: 44 }} pointerEvents="none" />
          <View style={styles.camera}>
            <CameraDragControl
              kind="zoom"
              value={zoom}
              onChange={setZoom}
              onActive={() => undefined}
            />
            <CameraDragControl
              kind="tilt"
              value={cameraTilt}
              onChange={setCameraTilt}
              onActive={() => undefined}
            />
            <CameraDragControl
              kind="height"
              value={cameraHeight}
              onChange={setCameraHeight}
              onActive={() => undefined}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open field menu"
            accessibilityState={{ expanded: menu === 'main' }}
            onPress={() => {
              setMenu(menu === 'main' ? null : 'main')
            }}
            style={[styles.circle, glassStyle]}
          >
            <View style={{ gap: 4 }}>
              {[0, 1, 2].map(i => (
                <View
                  key={i}
                  style={{
                    width: 18,
                    height: 2,
                    borderRadius: 1,
                    backgroundColor: '#fff'
                  }}
                />
              ))}
            </View>
          </Pressable>
        </View>
        {menu === 'main' && (
          <View style={[styles.mainMenu, glassStyle]}>
            {action('Resume field', () => {
              setMenu(null)
            })}
            {action('Exit field', onExit)}
          </View>
        )}
        <View pointerEvents="box-none" style={{ flex: 1 }} />
        {arcMode !== 'off' && (
          <View style={styles.arcRow}>
            <Text style={[styles.text, { flex: 1 }]}>
              {arcMode === 'aim'
                ? 'Choose landing'
                : arc != null && arc.angle < 0
                  ? 'Chopper'
                  : `${Math.round(arc?.angle ?? 30)}° launch`}
            </Text>
            {action(arcMode === 'aim' ? 'Cancel' : 'Done', () => {
              if (arcMode === 'aim') undo()
              else setArcMode('off')
            })}
          </View>
        )}
        {menu === 'more' && (
          <View style={[styles.moreMenu, glassStyle]}>
            {arc != null &&
              action('Adjust arc', () => {
                save('Adjust ball arc')
                setArcMode('edit')
                setMenu(null)
              })}
            {arc != null &&
              action('Clear arc', () => {
                save('Clear ball arc')
                setArc(null)
                setArcMode('off')
                setMenu(null)
              })}
            {action('Reset camera', () => {
              setZoom(DEFAULT_CAMERA.zoom)
              setCameraTilt(DEFAULT_CAMERA.tilt)
              setCameraHeight(DEFAULT_CAMERA.height)
              setMenu(null)
            })}
            {action('Reset players', () => {
              setPlayers(createPlayers())
              setMenu(null)
            })}
          </View>
        )}
        <View pointerEvents="box-none" style={styles.utilityRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="More"
            accessibilityState={{ expanded: menu === 'more' }}
            onPress={() => {
              setMenu(menu === 'more' ? null : 'more')
            }}
            style={[styles.utility, glassStyle]}
          >
            <Text style={styles.text}>⋮ More</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              undoEvent == null ? 'Nothing to undo' : `Undo ${undoEvent}`
            }
            disabled={history.length === 0}
            accessibilityState={{ disabled: history.length === 0 }}
            onPress={undo}
            style={[
              styles.utility,
              { flex: 1, minWidth: 0 },
              glassStyle,
              history.length === 0 && { opacity: 0.45 }
            ]}
          >
            <Text style={styles.text}>
              ↶ Undo{undoEvent == null ? '' : ` · ${undoEvent}`}
            </Text>
          </Pressable>
        </View>
        <View style={styles.pitchRow}>
          {pitches.map(item => (
            <Pressable
              key={item.kind}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              onPress={() => {
                pitch(item.kind)
              }}
              style={({ pressed }) => [
                styles.pitch,
                glassStyle,
                pressed && { backgroundColor: '#59694c' }
              ]}
            >
              <PitchIcon kind={item.kind} />
              <Text style={styles.pitchText}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  )
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#142c24', overflow: 'hidden' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4
  },
  camera: { flexDirection: 'row', gap: 4 },
  circle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#243b32a8',
    borderWidth: 1,
    borderColor: '#ffffff55'
  },
  text: { color: '#fffaf0', fontSize: 12, fontWeight: '600' },
  utilityRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 6
  },
  utility: {
    minHeight: 44,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#243b32c9',
    borderRadius: 14
  },
  pitchRow: { flexDirection: 'row', gap: 4 },
  pitch: {
    flex: 1,
    minWidth: 0,
    minHeight: 62,
    paddingHorizontal: 3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    backgroundColor: '#243b32db',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#ffffff38'
  },
  pitchText: {
    flexShrink: 1,
    color: '#fffaf0',
    fontWeight: '700',
    fontSize: 11,
    lineHeight: 14
  },
  menuItem: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14 },
  mainMenu: {
    alignSelf: 'flex-end',
    marginTop: 8,
    borderRadius: 16,
    backgroundColor: '#182e26ef',
    padding: 4
  },
  moreMenu: {
    alignSelf: 'flex-start',
    marginBottom: 8,
    borderRadius: 16,
    backgroundColor: '#182e26ef',
    padding: 4
  },
  arcRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: '#182e26db',
    paddingLeft: 12,
    marginBottom: 8
  }
})
