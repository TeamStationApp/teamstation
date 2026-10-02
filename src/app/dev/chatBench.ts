import type React from 'react'

/**
 * The chat crypto bench, in the builds that have it: none on the web.
 *
 * The phone twin, `chatBench.native.ts`, has it when `TS_CHAT_BENCH=1` was set
 * at build time. Here there is neither an address nor a screen, so the web
 * bundle holds no `/dev/chat-bench` route and no bench at all.
 */
export const chatBenchPath: string | undefined = undefined

export const ChatBench: React.ComponentType | undefined = undefined
