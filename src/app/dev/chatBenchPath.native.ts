import { chatBenchPath as benchPath } from './chatBench.native'

/**
 * The chat crypto bench's address on a phone: the bench's own, set only in a
 * build made with `TS_CHAT_BENCH=1` (`chatBench.native.ts`).
 */
export const chatBenchPath: string | undefined = benchPath
