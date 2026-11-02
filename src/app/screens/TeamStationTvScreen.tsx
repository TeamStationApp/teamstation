import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { type TvLoginPreview, tvTokenOfUrl } from '../../common/tvLogin'
import { Button, Screen } from '../components'
import { CancelAction } from '../components/CancelAction'
import { QrScanner, qrScannerSupported } from '../scoring/qrScanner'
import type { QrScannerProps } from '../scoring/qrScannerProps'
import { ScopedThemeProvider } from '../theme/ThemeContext'
import { tsDark } from '../theme/tsDark'
import { TvBackdrop, TvBrand } from '../tv/TvBrand'

const defaultCamera = { supported: qrScannerSupported, View: QrScanner }
const tvTheme = { ...tsDark, backgroundColor: 'transparent' }

export interface TeamStationTvScreenProps {
  client: TeamStationClient
  /** A QR link is inspected on arrival; it never approves itself. */
  token?: string
  appOrigin?: string
  camera?: { supported: boolean; View: React.ComponentType<QrScannerProps> }
}
export function TeamStationTvScreen(
  props: TeamStationTvScreenProps
): React.ReactElement {
  return (
    <ScopedThemeProvider theme={tvTheme}>
      <Approval {...props} />
    </ScopedThemeProvider>
  )
}
function Approval({
  client,
  token,
  appOrigin = 'https://app.teamstation.app',
  camera = defaultCamera
}: TeamStationTvScreenProps): React.ReactElement {
  const input = useRef<React.ComponentRef<typeof TextInput>>(null)
  const mounted = useRef(false)
  const working = useRef(false)
  const generation = useRef(0)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [success, setSuccess] = useState(false)
  const [scan, setScan] = useState(false)
  const [preview, setPreview] = useState<{
    token: string
    device: TvLoginPreview
  }>()
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      working.current = false
    }
  }, [])
  const cancel = (): void => {
    generation.current++
    working.current = false
    setBusy(false)
    setPreview(undefined)
    setScan(false)
  }
  const inspect = useCallback(
    async (value: string): Promise<void> => {
      if (working.current) return
      working.current = true
      const current = ++generation.current
      setBusy(true)
      setMessage('')
      setScan(false)
      try {
        const device = await client.inspectTvLogin(value)
        if (!mounted.current || current !== generation.current) return
        setExpired(device.expiresAt <= Date.now())
        setPreview({ token: value, device })
      } catch (error) {
        if (mounted.current && current === generation.current)
          setMessage(
            error instanceof Error
              ? error.message
              : 'Unable to read this TV code. Try again.'
          )
      } finally {
        if (mounted.current && current === generation.current) {
          working.current = false
          setBusy(false)
        }
      }
    },
    [client]
  )
  useEffect(() => {
    if (token != null) inspect(token).catch(() => undefined)
  }, [token, inspect])
  useEffect(() => {
    if (preview == null) return
    const timer = setTimeout(
      () => {
        setExpired(true)
      },
      Math.max(0, preview.device.expiresAt - Date.now())
    )
    return () => {
      clearTimeout(timer)
    }
  }, [preview])
  async function approve(value: {
    code?: string
    token?: string
  }): Promise<void> {
    if (working.current) return
    working.current = true
    const current = ++generation.current
    setBusy(true)
    setMessage('')
    try {
      await client.approveTvLogin(value)
      if (!mounted.current || current !== generation.current) return
      setPreview(undefined)
      setSuccess(true)
      Keyboard.dismiss()
    } catch (error) {
      if (mounted.current && current === generation.current) {
        setMessage(
          error instanceof Error
            ? error.message
            : 'Unable to sign in the TV. Try again.'
        )
        setCode('')
      }
    } finally {
      if (mounted.current && current === generation.current) {
        working.current = false
        setBusy(false)
      }
    }
  }
  const edit = (value: string): void => {
    if (working.current || success) return
    const letters = value
      .replace(/[^a-z]/gi, '')
      .toUpperCase()
      .slice(0, 8)
    setCode(letters)
    setMessage('')
    if (letters.length === 8) approve({ code: letters }).catch(() => undefined)
  }
  return (
    <View style={styles.scene}>
      <TvBackdrop />
      <Screen centreContent contentStyle={styles.content}>
        <TvBrand />
        <Text style={styles.copy}>
          Use TeamStation on Apple TV and Google TV from your TV’s app store.
        </Text>
        {success ? (
          <View accessibilityLiveRegion="polite" style={styles.content}>
            <Text style={styles.title}>Your TV is signed in</Text>
            <Button
              label="Connect another TV"
              onPress={() => {
                setSuccess(false)
                setCode('')
              }}
            />
          </View>
        ) : (
          <>
            <Text style={styles.copy}>
              Enter the eight letters shown on your TV to sign it in.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Enter TV code"
              onPress={() => input.current?.focus()}
              style={styles.code}
            >
              <View pointerEvents="none" style={styles.boxes}>
                {Array.from({ length: 8 }, (_, i) => (
                  <View
                    key={i}
                    style={[styles.box, i === 4 && styles.secondGroup]}
                  >
                    <Text style={styles.letter}>{code[i] ?? ''}</Text>
                  </View>
                ))}
              </View>
              <TextInput
                ref={input}
                testID="tv-code"
                accessibilityLabel="Eight-letter TV login code"
                value={code}
                onChangeText={edit}
                editable={!busy}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                keyboardType="default"
                selection={{ start: code.length, end: code.length }}
                style={styles.input}
              />
            </Pressable>
            {busy && (
              <Text style={styles.copy} accessibilityLiveRegion="polite">
                Connecting…
              </Text>
            )}
            <Text style={styles.copy}>or</Text>
            <Button
              label="⌜⌟  Scan QR code"
              accessibilityLabel="Scan QR code"
              color="#ffffff"
              textColor="#111111"
              disabled={busy}
              onPress={() => {
                setMessage('')
                if (camera.supported) setScan(true)
                else
                  setMessage(
                    'Scan the TV’s QR code with your phone’s camera, or enter its eight letters here.'
                  )
              }}
            />
          </>
        )}
        {message !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {message}
          </Text>
        )}
      </Screen>
      <Modal
        visible={scan}
        animationType="slide"
        onRequestClose={() => {
          cancel()
        }}
      >
        <View style={styles.scanner}>
          <camera.View
            active={scan && !busy}
            onCode={url => {
              const scanned = tvTokenOfUrl(url, appOrigin)
              if (scanned == null) {
                setScan(false)
                setMessage('That is not a TeamStation TV QR code.')
              } else inspect(scanned).catch(() => undefined)
            }}
            onStatus={status => {
              if (status !== 'ready') {
                setScan(false)
                setMessage(
                  status === 'denied'
                    ? 'Camera access is disabled. Use your phone’s camera or enter the eight letters.'
                    : 'No camera is available. Enter the eight letters shown on your TV.'
                )
              }
            }}
          />
          <CancelAction
            onPress={() => {
              cancel()
            }}
          />
        </View>
      </Modal>
      <Modal
        visible={preview != null}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!busy) cancel()
        }}
      >
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <Text style={styles.title}>
              Log in to {preview?.device.platform}
            </Text>
            <Text style={styles.copy}>
              {preview?.device.location == null
                ? 'Location unavailable'
                : `Approximate location: ${preview.device.location}`}
            </Text>
            <Text style={styles.copy}>
              Sign this TV in to your TeamStation account?
            </Text>
            {expired && (
              <Text style={styles.error}>
                This code has expired. Scan the new code on your TV.
              </Text>
            )}
            {message !== '' && (
              <Text accessibilityRole="alert" style={styles.error}>
                {message}
              </Text>
            )}
            <Button
              label="Login"
              color="#27834e"
              textColor="#ffffff"
              busy={busy}
              disabled={expired || busy}
              onPress={() => {
                if (preview != null)
                  approve({ token: preview.token }).catch(() => undefined)
              }}
            />
            <CancelAction
              disabled={busy}
              onPress={() => {
                cancel()
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  )
}
const styles = StyleSheet.create({
  scene: { flex: 1, backgroundColor: '#000' },
  content: {
    alignItems: 'center',
    gap: 24,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingVertical: 36
  },
  copy: {
    fontSize: 16,
    lineHeight: 24,
    color: '#ddd',
    textAlign: 'center',
    maxWidth: 420
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center'
  },
  code: { width: '100%', maxWidth: 420, height: 52 },
  boxes: { flexDirection: 'row', gap: 5, height: 52 },
  box: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#76847a',
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#12251c'
  },
  secondGroup: { marginLeft: 10 },
  letter: { fontSize: 24, fontWeight: '600', color: '#fff' },
  input: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    color: 'transparent',
    backgroundColor: 'transparent',
    opacity: 0.02,
    fontSize: 16
  },
  error: { color: '#ffaaa3', fontSize: 16, textAlign: 'center' },
  scanner: { flex: 1, backgroundColor: '#000', padding: 24 },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#0009' },
  sheet: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    padding: 28,
    paddingBottom: 40,
    gap: 20,
    alignItems: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: '#14251b'
  }
})
