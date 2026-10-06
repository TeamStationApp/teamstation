import type React from 'react'

/**
 * The chat crypto bench on the web: in a bundle `src/build.mjs --serve`
 * makes, where esbuild defines `__DEV__` true, and in no other.
 *
 * A production build defines it false, so the minifier drops both branches
 * below and its bundle holds no `/dev/chat-bench` route and no bench screen;
 * the unbundled tests define nothing and never load the screen either. In a
 * served build it runs every frozen vector on the browser's WebAssembly core
 * and times it, as the phone twin (`chatBench.native.ts`) does on the native
 * core.
 */
export const chatBenchPath: string | undefined =
  typeof __DEV__ !== 'undefined' && __DEV__ ? '/dev/chat-bench' : undefined

export const ChatBench: React.ComponentType | undefined =
  typeof __DEV__ !== 'undefined' && __DEV__
    ? // Required here, not imported, so only a served bundle holds it.
      (require('./ChatBenchScreen') as { ChatBenchScreen: React.ComponentType })
        .ChatBenchScreen
    : undefined
