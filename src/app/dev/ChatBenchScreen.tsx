import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import { loadChatCore } from '../../common/chatCrypto/core'
import type { ChatCoreStatus } from '../../common/chatCrypto/coreCall'
import { vectorSummary } from '../../common/chatCrypto/vectors'
import { Button } from '../components/Button'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  benchLines,
  type ChatBenchOptions,
  type ChatBenchResult,
  runChatBench
} from './chatBenchRun'
import { probeIdentityStorage } from './chatIdentityStoreProbe'
import type { IdentityProbeResult } from './chatIdentityStoreProbeRun'

export interface ChatBenchScreenProps extends ChatBenchOptions {
  /** The bench itself; tests hand in a small one. */
  run?: (options: ChatBenchOptions) => ChatBenchResult
  /** The frozen-vector check; tests hand in their own. */
  checkVectors?: () => string
  /** Loads this platform's chat crypto core; the real one by default. */
  loadCore?: () => Promise<ChatCoreStatus>
  /** Only this gated diagnostic screen may start the isolated storage check. */
  runStorageProbe?: (signal: AbortSignal) => Promise<IdentityProbeResult>
}

/**
 * The chat crypto bench, at `/dev/chat-bench` in a phone build made with
 * `TS_CHAT_BENCH=1` and nowhere else.
 *
 * It runs once, as soon as it is drawn and this platform's chat crypto core
 * has loaded (in a browser nothing else has loaded the module on this page;
 * without it the screen says why): first every frozen vector through the
 * TypeScript wrappers chat calls (`common/chatCrypto/vectors.ts`), on the
 * native core on a phone and the WebAssembly one in a browser, showing
 * `vectors ok` or the first mismatch;
 * then the bench, showing `stream MB/s` and `wraps/s`; then the word `done`,
 * which is what
 * `src/app/dev/chatBenchPhones.e2e.ts` waits for before its screenshot.
 * `App.tsx` draws it before asking about a session, because it needs no
 * account and no server: the bench build never signs in anywhere. It is at
 * `/dev/chat-bench` in a phone build made with `TS_CHAT_BENCH=1` and in a
 * web app served by `src/build.mjs --serve`, and nowhere else.
 */
export function ChatBenchScreen(
  props: ChatBenchScreenProps
): React.ReactElement {
  const {
    bytes,
    wraps,
    now,
    run = runChatBench,
    checkVectors = vectorSummary,
    loadCore = loadChatCore,
    runStorageProbe = probeIdentityStorage
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [lines, setLines] = useState<string[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const probe = useRef<AbortController | undefined>(undefined)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<
    IdentityProbeResult | undefined
  >(undefined)
  const [probeFailed, setProbeFailed] = useState(false)
  useEffect(
    () => () => {
      probe.current?.abort()
    },
    []
  )
  const checkStorage = (): void => {
    if (probe.current != null || lines?.[0] !== 'vectors ok') return
    const controller = new AbortController()
    probe.current = controller
    setProbing(true)
    setProbeResult(undefined)
    setProbeFailed(false)
    runStorageProbe(controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setProbeResult(result)
      })
      .catch(() => {
        if (!controller.signal.aborted) setProbeFailed(true)
      })
      .finally(() => {
        if (probe.current === controller) probe.current = undefined
        if (!controller.signal.aborted) setProbing(false)
      })
  }

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    loadCore()
      .then(status => {
        if (!live) return
        if (!status.ready) {
          setError(`no chat crypto core: ${status.reason}`)
          return
        }
        // After a frame, so "Running" is on screen before the work blocks
        // the JavaScript thread for the seconds it takes.
        timer = setTimeout(() => {
          try {
            // The vectors first: a fast figure from a core that gives other
            // bytes than the server's would be no result at all.
            const vectors = checkVectors()
            setLines([vectors, ...benchLines(run({ bytes, wraps, now }))])
          } catch (caught: unknown) {
            setError(caught instanceof Error ? caught.message : String(caught))
          }
        }, 250)
      })
      .catch((caught: unknown) => {
        if (live) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
    return () => {
      live = false
      if (timer != null) clearTimeout(timer)
    }
  }, [bytes, wraps, now, run, checkVectors, loadCore])

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }
      ]}
    >
      <Text accessibilityRole="header" style={styles.title}>
        Chat crypto bench
      </Text>
      {lines == null && error == null ? (
        <View accessibilityLabel="running" style={styles.running}>
          <ActivityIndicator color={theme.secondaryTextColor} />
          <Text style={styles.line}>Running…</Text>
        </View>
      ) : null}
      {lines?.map(line => (
        <Text key={line} style={styles.line}>
          {line}
        </Text>
      ))}
      {error != null ? (
        <Text style={styles.line}>{`failed: ${error}`}</Text>
      ) : null}
      {lines != null || error != null ? (
        <Text style={styles.done}>done</Text>
      ) : null}
      <Button
        label="Check saved chat compatibility"
        onPress={checkStorage}
        disabled={probing || lines?.[0] !== 'vectors ok'}
      />
      {probing ? (
        <Text style={styles.line}>Checking isolated synthetic storage…</Text>
      ) : null}
      {probeFailed ? (
        <Text style={styles.line}>identity storage failed</Text>
      ) : null}
      {probeResult == null ? null : (
        <>
          <Text style={styles.line}>identity storage ok</Text>
          <Text testID="chat-identity-storage-result" style={styles.line}>
            {JSON.stringify(probeResult)}
          </Text>
        </>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  screen: {
    flex: 1,
    paddingHorizontal: 24,
    backgroundColor: theme.backgroundColor
  },
  title: {
    color: theme.primaryTextColor,
    fontSize: 22,
    fontWeight: '700' as const,
    marginBottom: 16
  },
  running: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8
  },
  line: {
    color: theme.primaryTextColor,
    fontSize: 17,
    marginBottom: 8
  },
  done: {
    color: theme.primaryTextColor,
    fontSize: 17,
    fontWeight: '700' as const,
    marginTop: 8
  }
}))
