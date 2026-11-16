/**
 * The web's answer to a request that missed its deadline: none. The browser
 * keeps its own connections. The phone's is `stalledConnections.native.ts`.
 */
export const leaveStalledConnections: (() => void) | undefined = undefined
