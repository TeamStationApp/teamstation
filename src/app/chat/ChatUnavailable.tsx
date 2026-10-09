import React from 'react'
import { Platform, Text } from 'react-native'

import type { CoreUnavailableReason } from '../../common/chatCrypto/coreCall'
import { Screen } from '../components'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { getChatStyles } from './chatStyles'

export interface ChatUnavailableProps {
  reason: CoreUnavailableReason
  /** Where it is drawn; this platform by default. */
  platform?: string
}

/**
 * Chat without its crypto core: what is missing, why, and that the rest of
 * TeamStation works. A browser without WebAssembly (or with it turned off,
 * as Lockdown Mode does in Safari) and a browser whose module would not
 * load or check out both need WebAssembly. A phone has no WebAssembly and no
 * page to reload: a build without the native module, or with one that gives
 * other bytes, has no chat at all.
 */
export function ChatUnavailable(
  props: ChatUnavailableProps
): React.ReactElement {
  const { reason, platform = Platform.OS } = props
  const styles = getChatStyles(useTheme())
  const phone = platform !== 'web' || reason === 'noNativeModule'
  return (
    <Screen>
      <Text style={styles.title}>
        {phone
          ? lstrings.chat_core_not_in_build
          : lstrings.chat_core_needs_webassembly}
      </Text>
      {!phone && (
        <Text style={styles.muted}>
          {reason === 'noWebAssembly'
            ? lstrings.chat_core_no_webassembly
            : lstrings.chat_core_module_failed}
        </Text>
      )}
      <Text style={styles.muted}>{lstrings.chat_core_rest_works}</Text>
    </Screen>
  )
}
