import qrcode from 'qrcode-generator'
import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore
} from 'react'
import { NativeModules, StyleSheet, Text, View } from 'react-native'
import { Path, Rect, Svg } from 'react-native-svg'

import { TeamStationClient } from '../../common/api'
import { ScopedThemeProvider } from '../theme/ThemeContext'
import { tsDark } from '../theme/tsDark'
import { PlaybackProbe } from './PlaybackProbe'
import { TvSessionController, type TvSessionStore } from './session'
import { TvBackdrop, TvBrand } from './TvBrand'
import { TvBrowser, type TvPlayRequest } from './TvBrowser'
import { TvButton } from './TvButton'
import { TvPlayer } from './TvPlayer'

export function TvQr({ value }: { value: string }): React.ReactElement {
  const qr = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()
    return qr
  }, [value])
  const count = qr.getModuleCount()
  let path = ''
  for (let y = 0; y < count; y++)
    for (let x = 0; x < count; x++)
      if (qr.isDark(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`
  return (
    <Svg
      accessibilityLabel="Scan to sign in"
      width={310}
      height={310}
      viewBox={`0 0 ${count + 8} ${count + 8}`}
    >
      <Rect width={count + 8} height={count + 8} fill="#fff" />
      <Path d={path} fill="#000" />
    </Svg>
  )
}
export function TvApp({
  apiBaseUrl = 'https://app.teamstation.app/api/v1',
  probeUrls
}: {
  apiBaseUrl?: string
  probeUrls?: string
}): React.ReactElement {
  const client = useMemo(
    () => new TeamStationClient({ baseUrl: apiBaseUrl }),
    [apiBaseUrl]
  )
  const controller = useMemo(
    () =>
      new TvSessionController(
        client,
        NativeModules.TVSession as TvSessionStore,
        apiBaseUrl
      ),
    [client, apiBaseUrl]
  )
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const [now, setNow] = useState(Date.now())
  const [playing, setPlaying] = useState<TvPlayRequest | null>(null)
  useEffect(() => {
    if (__DEV__ && probeUrls != null && probeUrls !== '') return
    controller.boot().catch(() => undefined)
    return () => {
      controller.stop()
    }
  }, [controller, probeUrls])
  useEffect(() => {
    if (state.phase !== 'login') return
    setNow(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [state.phase])
  return (
    <ScopedThemeProvider theme={tsDark}>
      <View style={[styles.scene, state.phase === 'ready' && styles.browsing]}>
        <TvBackdrop />
        {__DEV__ && probeUrls != null && probeUrls !== '' ? (
          <PlaybackProbe urls={probeUrls.split('|')} />
        ) : state.phase === 'login' && state.request != null ? (
          <View style={styles.login}>
            <View style={styles.column}>
              <TvBrand />
              <Text style={styles.title}>Your games. On the big screen.</Text>
              <Text style={styles.copy}>
                Scan the QR code with your phone’s camera, or open TeamStation
                TV from your account on a signed-in phone or computer.
              </Text>
            </View>
            <View style={styles.column}>
              <TvQr value={state.request.qrUrl} />
              <Text
                testID="tv-login-code"
                accessibilityLabel={`TV login code ${state.request.displayCode}`}
                style={styles.code}
              >
                {state.request.displayCode}
              </Text>
              <Text style={styles.copy}>
                New code in{' '}
                {Math.max(0, Math.ceil((state.request.expiresAt - now) / 1000))}{' '}
                seconds
              </Text>
              <Text style={styles.hint}>
                Enter these eight letters on your signed-in device.
              </Text>
            </View>
          </View>
        ) : state.phase === 'ready' ? (
          <>
            <View style={[styles.browser, playing !== null && styles.hidden]}>
              <TvBrowser
                client={client}
                visible={playing === null}
                viewerName={state.session?.user.displayName ?? ''}
                onPlay={setPlaying}
                onSignOut={() => {
                  setPlaying(null)
                  controller.signOut().catch(() => undefined)
                }}
              />
            </View>
            {playing !== null && (
              <TvPlayer
                client={client}
                request={playing}
                onClose={() => {
                  setPlaying(null)
                }}
              />
            )}
          </>
        ) : (
          <View style={styles.column}>
            <TvBrand />
            <Text style={styles.copy}>
              {state.phase === 'error' ? state.error : 'Connecting…'}
            </Text>
            {state.phase === 'error' && (
              <TvButton
                label="Retry"
                onPress={() => {
                  controller.boot().catch(() => undefined)
                }}
              />
            )}
          </View>
        )}
      </View>
    </ScopedThemeProvider>
  )
}
const styles = StyleSheet.create({
  browsing: { padding: 0 },
  browser: { flex: 1, width: '100%' },
  hidden: { display: 'none' },
  scene: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 70
  },
  login: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 100,
    maxWidth: 1600
  },
  column: { alignItems: 'center', gap: 28, maxWidth: 680, flexShrink: 1 },
  title: {
    fontSize: 40,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center'
  },
  copy: { fontSize: 25, lineHeight: 36, color: '#ddd', textAlign: 'center' },
  hint: { fontSize: 22, color: '#bbb', textAlign: 'center' },
  code: { fontSize: 52, letterSpacing: 8, fontWeight: '700', color: '#fff' }
})
