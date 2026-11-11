import React, { useState } from 'react'
import {
  AppRegistry,
  Pressable,
  Text,
  type TextStyle,
  View
} from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { ButtonIcon } from '../app/components/ButtonIcon'
import { TsMark } from '../app/components/TsMark'
import { ThemeProvider, useTheme } from '../app/theme/ThemeContext'

const names = ['home', 'menu', 'reply', 'more', 'check', 'pin'] as const

/** Compare actual native text advances, including the styled-box case. */
function TextWidths(): React.ReactElement {
  const theme = useTheme()
  const [widths, setWidths] = useState<
    Record<string, { width: number; height: number }>
  >({})
  const examples = [
    { key: 'left', glyph: '‹', name: 'chevron_left' as const },
    { key: 'right', glyph: '›', name: 'chevron_right' as const },
    { key: 'plus', glyph: '+', name: 'add' as const },
    { key: 'styled', glyph: '›', name: 'chevron_right' as const }
  ]
  return (
    <View style={{ marginTop: 16 }}>
      <Text>Original / centered text widths</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {examples.map(({ key, glyph, name }) => {
          const style: TextStyle = {
            fontFamily: theme.regularTextFont,
            fontSize: 22,
            lineHeight: 24,
            paddingRight: 4
          }
          if (key === 'styled')
            Object.assign(style, {
              width: 42,
              height: 30,
              borderWidth: 2,
              borderRadius: 7,
              backgroundColor: '#ddeeff',
              textAlign: 'right'
            })
          const text = <Text style={style}>{glyph}</Text>
          const matches =
            widths[`${key}-before`] != null &&
            widths[`${key}-after`] != null &&
            Math.abs(
              widths[`${key}-before`].width - widths[`${key}-after`].width
            ) < 0.25 &&
            Math.abs(
              widths[`${key}-before`].height - widths[`${key}-after`].height
            ) < 0.25
          return (
            <View key={key} style={{ alignItems: 'flex-start' }}>
              {[false, true].map(after => (
                <View
                  key={String(after)}
                  onLayout={event => {
                    const { width, height } = event.nativeEvent.layout
                    const id = `${key}-${after ? 'after' : 'before'}`
                    setWidths(previous =>
                      previous[id]?.width === width &&
                      previous[id]?.height === height
                        ? previous
                        : { ...previous, [id]: { width, height } }
                    )
                  }}
                >
                  {after ? <ButtonIcon name={name}>{text}</ButtonIcon> : text}
                </View>
              ))}
              <Text style={{ fontSize: 10 }}>
                {matches ? `Width kept: ${key}` : `Width pending: ${key}`}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

/** Paint every shared artwork branch at normal and large sizes on native. */
function ButtonIconGallery(): React.ReactElement {
  const [action, setAction] = useState('ready')
  return (
    <ThemeProvider>
      <View
        style={{
          flex: 1,
          backgroundColor: '#f5f7f1',
          padding: 16,
          paddingTop: 64
        }}
      >
        <Text style={{ fontSize: 22, textAlign: 'center' }}>Icon gallery</Text>
        <Text
          style={{ textAlign: 'center', marginVertical: 12 }}
        >{`Action: ${action}`}</Text>
        {[
          { label: 'Default', size: 1.25, disabled: false },
          { label: 'Large', size: 2.5, disabled: false },
          { label: 'Disabled', size: 1.25, disabled: true }
        ].map(({ label, size, disabled }) => (
          <View key={label} style={{ marginVertical: 12 }}>
            <Text style={{ marginBottom: 8 }}>{label}</Text>
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between' }}
            >
              {names.map(name => (
                <Pressable
                  key={name}
                  accessibilityRole="button"
                  accessibilityLabel={`${label} ${name}`}
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={() => {
                    setAction(`${label} ${name}`)
                  }}
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#e2e8d9',
                    opacity: disabled ? 0.4 : 1
                  }}
                >
                  <ButtonIcon name={name} size={size} color="#20351c" />
                </Pressable>
              ))}
            </View>
          </View>
        ))}
        <Text style={{ marginTop: 12 }}>
          Home · Menu · Reply · More · Check · Pin
        </Text>
        <View style={{ marginTop: 24, alignItems: 'center' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Large vector"
            onPress={() => {
              setAction('vector')
            }}
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#e2e8d9'
            }}
          >
            <ButtonIcon>
              <TsMark size={2.5} />
            </ButtonIcon>
          </Pressable>
          <Text>Large vector artwork</Text>
        </View>
        <TextWidths />
      </View>
    </ThemeProvider>
  )
}

function Root(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ButtonIconGallery />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('TeamStation', () => Root)
