import type React from 'react'

import { ChatBenchScreen } from './ChatBenchScreen'

/**
 * The chat crypto bench, in a phone build made with `TS_CHAT_BENCH=1`: its
 * address `/dev/chat-bench` and its screen, and neither otherwise.
 *
 * Babel inlines the variable (`babel.config.js`), Gradle rebuilds the bundle
 * when it changes (`android/app/build.gradle`) and Metro keys its cache on it
 * (`metro.config.js`), so a shipped build, made without it, never has the
 * route. The bench needs no account and no server; see `ChatBenchScreen`.
 */
declare const process: { env: Record<string, string | undefined> }

/** The bench's address and screen for a value of `TS_CHAT_BENCH`. */
export function benchFor(flag: string | undefined): {
  path: string | undefined
  screen: React.ComponentType | undefined
} {
  return flag === '1'
    ? { path: '/dev/chat-bench', screen: ChatBenchScreen }
    : { path: undefined, screen: undefined }
}

const bench = benchFor(process.env.TS_CHAT_BENCH)

export const chatBenchPath: string | undefined = bench.path

export const ChatBench: React.ComponentType | undefined = bench.screen
