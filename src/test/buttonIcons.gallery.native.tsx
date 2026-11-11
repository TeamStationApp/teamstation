import React, { useState } from 'react'
import { AppRegistry, Pressable, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { ButtonIcon } from '../app/components/ButtonIcon'
import { TsMark } from '../app/components/TsMark'
import { ThemeProvider } from '../app/theme/ThemeContext'

const names = ['home', 'menu', 'reply', 'more', 'check', 'pin'] as const

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
