import React, { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import { vectorSummary } from '../../common/chatCrypto/vectors'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  benchLines,
  type ChatBenchOptions,
  type ChatBenchResult,
  runChatBench
} from './chatBenchRun'

export interface ChatBenchScreenProps extends ChatBenchOptions {
  /** The bench itself; tests hand in a small one. */
  run?: (options: ChatBenchOptions) => ChatBenchResult
  /** The frozen-vector check; tests hand in their own. */
  checkVectors?: () => string
}

/**
 * The chat crypto bench, at `/dev/chat-bench` in a phone build made with
 * `TS_CHAT_BENCH=1` and nowhere else.
 *
 * It runs once, as soon as it is drawn: first every frozen vector of
 * `common/chatCrypto/vectors.ts` through this platform's `primitives` (on a
 * phone, `primitives.native.ts`), showing `vectors ok` or the first mismatch;
 * then the bench, showing `stream MB/s` and `wraps/s`; then the word `done`,
 * which is what
 * `src/app/dev/chatBenchPhones.e2e.ts` waits for before its screenshot.
 * `App.tsx` draws it before asking about a session, because it needs no
 * account and no server: the bench build never signs in anywhere.
 */
export function ChatBenchScreen(
  props: ChatBenchScreenProps
): React.ReactElement {
  const {
    bytes,
    wraps,
    now,
    run = runChatBench,
    checkVectors = vectorSummary
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [lines, setLines] = useState<string[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    // After a frame, so "Running" is on screen before the work blocks the
    // JavaScript thread for the seconds it takes.
    const timer = setTimeout(() => {
      try {
        // The vectors first: a fast figure from primitives that give other
        // bytes than the server's would be no result at all.
        const vectors = checkVectors()
        setLines([vectors, ...benchLines(run({ bytes, wraps, now }))])
      } catch (caught: unknown) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }, 250)
    return () => {
      clearTimeout(timer)
    }
  }, [bytes, wraps, now, run, checkVectors])

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
