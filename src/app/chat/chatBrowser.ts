import { openExternal } from '../platform/externalBrowser'

export const openChatBrowser = openExternal
export const chatAppOrigin = (): string => window.location.origin
