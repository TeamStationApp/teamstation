import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import type * as Config from './config'
import type * as RootModule from './index'

/**
 * The native entry point, over stand-ins for React Native, the app and the
 * phone's stores, which need the phone; the stand-ins are put where Node
 * would load the modules from, as `sessionStore.native.test.ts` does. What
 * it hands `App` is the point: the API this launch talks to (`launchApi`,
 * shared with the session store and Android's background task), the kept
 * session, and the store's calls.
 */
const file = require.resolve('./index')
const here = (name: string): string => require.resolve(name)
const paths = {
  reactNative: here('react-native'),
  gestures: here('react-native-gesture-handler'),
  safeArea: here('react-native-safe-area-context'),
  app: here('../App'),
  addressBar: here('../navigation/useAddressBar'),
  session: here('../platform/sessionStore'),
  cache: here('../sync/cache'),
  theme: here('../theme/ThemeContext'),
  launch: here('./launchApi')
}

const stand = (path: string, exports: unknown): void => {
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports
  } as unknown as NodeJS.Module
}

const passThrough = ({
  children
}: {
  children?: React.ReactNode
}): React.ReactElement => React.createElement(React.Fragment, null, children)

interface AppProps {
  apiBaseUrl: string
  initialToken?: string
  initialUser?: { id: string }
  onToken: (token: string | undefined) => void
  onUser: (user: { id: string } | undefined) => void
  forgetSessionCookie?: () => Promise<void>
  documentCache: unknown
}

/** The entry point over stand-ins, recording what reaches `App` and the stores. */
function load(options: {
  api: string
  token?: () => Promise<string | undefined>
}): {
  Root: typeof RootModule.Root
  rendered: AppProps[]
  saved: unknown[]
  seeded: unknown[]
  forget: () => Promise<void>
  openDocumentCache: () => void
} {
  const rendered: AppProps[] = []
  const saved: unknown[] = []
  const seeded: unknown[] = []
  const forget = async (): Promise<void> => undefined
  const openDocumentCache = (): void => undefined
  Reflect.deleteProperty(require.cache, file)
  stand(paths.reactNative, {
    Alert: { alert: () => undefined },
    Linking: {
      getInitialURL: async () => null,
      addEventListener: () => ({ remove: () => undefined })
    },
    StatusBar: () => null,
    View: passThrough
  })
  stand(paths.gestures, { GestureHandlerRootView: passThrough })
  stand(paths.safeArea, { SafeAreaProvider: passThrough })
  stand(paths.app, {
    App: (props: AppProps) => {
      rendered.push(props)
      return null
    }
  })
  stand(paths.addressBar, {
    seedRoute: (route: unknown) => {
      seeded.push(route)
    }
  })
  stand(paths.session, {
    loadToken: options.token ?? (async () => 'kept-token'),
    loadUser: async () => ({ id: 'usr_kept' }),
    saveToken: async (token: string | undefined) => {
      saved.push(['token', token])
    },
    saveUser: async (user: unknown) => {
      saved.push(['user', user])
    },
    forgetSessionCookie: forget
  })
  stand(paths.cache, { openDocumentCache })
  stand(paths.theme, {
    getTheme: () => ({ isDark: false, backgroundColor: '#ffffff' })
  })
  stand(paths.launch, { launchApi: async () => options.api })
  const { Root } = require('./index') as typeof RootModule
  return { Root, rendered, saved, seeded, forget, openDocumentCache }
}

/** Mounts `Root` and lets its launch settle. */
async function mounted(Root: typeof RootModule.Root): Promise<() => void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(Root))
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  return () => {
    act(() => {
      root.unmount()
    })
    host.remove()
  }
}

describe('the native entry point', function () {
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  const config = require('./config') as typeof Config
  afterEach(function () {
    for (const path of [file, ...Object.values(paths)])
      Reflect.deleteProperty(require.cache, path)
    config.setLaunchApiBaseUrl(config.apiBaseUrl)
  })

  it('opens the app on the API this launch talks to, with the kept session and the store’s calls', async function () {
    const api = 'https://stack.example.test/api/v1'
    const loaded = load({ api })
    const unmount = await mounted(loaded.Root)
    try {
      const props = loaded.rendered.at(-1)
      expect(props?.apiBaseUrl).equals(api)
      expect(config.currentApiBaseUrl()).equals(api)
      expect(props?.initialToken).equals('kept-token')
      expect(props?.initialUser).deep.equals({ id: 'usr_kept' })
      // Sign Out takes the session cookie out of the phone's jar through it.
      expect(props?.forgetSessionCookie).equals(loaded.forget)
      expect(props?.documentCache).equals(loaded.openDocumentCache)
      props?.onToken(undefined)
      props?.onUser({ id: 'usr_next' })
      await act(async () => undefined)
      expect(loaded.saved).deep.equals([
        ['token', undefined],
        ['user', { id: 'usr_next' }]
      ])
      expect(loaded.seeded).deep.equals([null])
    } finally {
      unmount()
    }
  })

  it('opens on the built API with nobody when the launch cannot be read', async function () {
    const loaded = load({
      api: 'https://stack.example.test/api/v1',
      token: async () => {
        throw new Error('The store will not open')
      }
    })
    const unmount = await mounted(loaded.Root)
    try {
      const props = loaded.rendered.at(-1)
      expect(props?.apiBaseUrl).equals(config.apiBaseUrl)
      expect(props?.initialToken).equals(undefined)
    } finally {
      unmount()
    }
  })
})
