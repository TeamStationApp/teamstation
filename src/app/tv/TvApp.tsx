import qrcode from 'qrcode-generator'
import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore
} from 'react'
import {
  NativeModules,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
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

const loginWidth = 1600
const loginHeight = 940
export function tvLoginScale(width: number, height: number): number {
  return Math.max(
    0,
    Math.min(1, (width - 140) / loginWidth, (height - 140) / loginHeight)
  )
}

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
    <View style={styles.qrCard}>
      <Svg
        accessibilityLabel="Scan to sign in"
        width={620}
        height={620}
        viewBox={`0 0 ${count + 8} ${count + 8}`}
      >
        <Rect
          width={count + 8}
          height={count + 8}
          rx={(24 * (count + 8)) / 620}
          fill="#fff"
        />
        <Path d={path} fill="#000" />
      </Svg>
    </View>
  )
}
export function TvApp({
  apiBaseUrl = 'https://app.teamstation.app/api/v1',
  probeUrls
}: {
  apiBaseUrl?: string
  probeUrls?: string
}): React.ReactElement {
  const { width, height } = useWindowDimensions()
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
          <View
            testID="tv-login-panel"
            style={[
              styles.login,
              { transform: [{ scale: tvLoginScale(width, height) }] }
            ]}
          >
            <View style={styles.loginColumn}>
              <TvBrand
                title="TeamStation"
                titleSize={90}
                iconScale={2}
                subtleHalo
              />
              <Text style={styles.title}>Your games. On the big screen.</Text>
              <Text style={styles.loginCopy}>
                Scan the QR code with your phone's camera or open TeamStation
                and enter the 8-digit code in your account settings.
              </Text>
            </View>
            <View style={styles.loginColumn}>
              <TvQr value={state.request.qrUrl} />
              <Text
                testID="tv-login-code"
                accessibilityLabel={`TV login code ${state.request.displayCode}`}
                style={styles.code}
              >
                {state.request.displayCode}
              </Text>
            </View>
            <Text style={styles.countdown}>
              New code in{' '}
              {Math.max(0, Math.ceil((state.request.expiresAt - now) / 1000))}{' '}
              seconds
            </Text>
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
            <TvBrand title="TeamStation" />
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
  qrCard: {
    width: 620,
    height: 620,
    borderRadius: 24,
    backgroundColor: '#fff',
    shadowColor: '#a855f7',
    shadowOpacity: 0.56,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 0 }
  },
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
    width: loginWidth,
    height: loginHeight
  },
  loginColumn: { alignItems: 'center', gap: 18, width: 750, flexShrink: 1 },
  loginCopy: {
    fontSize: 25,
    lineHeight: 36,
    color: '#ddd',
    textAlign: 'center'
  },
  countdown: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    fontSize: 25,
    lineHeight: 36,
    color: '#ddd',
    textAlign: 'center'
  },
  column: { alignItems: 'center', gap: 28, maxWidth: 680, flexShrink: 1 },
  title: {
    fontSize: 50,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center'
  },
  copy: { fontSize: 25, lineHeight: 36, color: '#ddd', textAlign: 'center' },
  code: { fontSize: 52, letterSpacing: 8, fontWeight: '700', color: '#fff' }
})
