import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { AppNav, type NavTabId } from '../app/components/AppNav'
import { Button } from '../app/components/Button'
import { HeroCard } from '../app/components/HeroCard'
import { SettingsGear } from '../app/components/SettingsGear'
import { BaseballScreen } from '../app/field/BaseballScreen'
import { RosterRemoveButton } from '../app/scoring/RosterRemoveButton'
import { OverlayButton } from '../app/stream/overlay/OverlayButton'
import { ThemeProvider } from '../app/theme/ThemeContext'

/** Real controls with deterministic local state; no account or network required. */
export function ButtonIconsFixture(): React.ReactElement {
  const [selected, setSelected] = useState<NavTabId>('home')
  const [sound, setSound] = useState(true)
  const [action, setAction] = useState('ready')
  const [scoring, setScoring] = useState(false)
  return (
    <ThemeProvider>
      <View style={{ flex: 1, paddingTop: 60, backgroundColor: '#f5f7f1' }}>
        <Text testID="icon-action" style={{ textAlign: 'center', height: 24 }}>
          {`Action: ${action}`}
        </Text>
        {!scoring && (
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <View style={{ flex: 1 }}>
                <HeroCard
                  name="Owls"
                  secondary="Team"
                  onEdit={() => {
                    setAction('edit')
                  }}
                />
              </View>
              <SettingsGear
                label="Team settings"
                onPress={() => {
                  setAction('settings')
                }}
              />
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <Button
                label="Share"
                icon="share"
                onPress={() => {
                  setAction('share')
                }}
              />
              <RosterRemoveButton
                label="Remove player"
                onPress={() => {
                  setAction('remove')
                }}
              />
              <OverlayButton
                glyph="flip"
                testID="icon-flip"
                accessibilityLabel="Flip camera"
                onPress={() => {
                  setAction('flip')
                }}
              />
              <OverlayButton
                glyph="settings"
                testID="icon-overlay"
                accessibilityLabel="Camera settings"
                onPress={() => {
                  setAction('camera')
                }}
              />
            </View>
            <Button
              label="Show scoring"
              onPress={() => {
                setScoring(true)
              }}
            />
          </View>
        )}
        {scoring && (
          <View style={{ flex: 1, minHeight: 320 }}>
            <BaseballScreen
              suspended
              field={{
                players: [],
                selected: '',
                onSelect: () => {},
                view: 'home',
                zoom: 1
              }}
              summary="Icon positioning fixture"
              onMenu={() => {
                setAction('menu')
              }}
              onUndo={() => {
                setAction('undo')
              }}
              onPitch={kind => {
                setAction(kind)
              }}
              canPitch
              sound={{
                on: sound,
                onToggle: () => {
                  setSound(!sound)
                  setAction('sound')
                }
              }}
            />
          </View>
        )}
        {scoring && (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: 115, left: 90, right: 90 }}
          >
            <Text style={{ textAlign: 'center' }}>{`Action: ${action}`}</Text>
          </View>
        )}
        <View style={{ height: 110 }} />
        {!scoring && (
          <AppNav
            selected={selected}
            mode="floating"
            onSelect={id => {
              setSelected(id)
              setAction(id)
            }}
          />
        )}
      </View>
    </ThemeProvider>
  )
}
