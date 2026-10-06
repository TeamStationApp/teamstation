/** Device-test entry point. Build explicitly with ENTRY_FILE; never used by the product. */
import React, { useState } from 'react'
import { AppRegistry, Button, ScrollView, Text, TextInput } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { passwordKdf } from '../app/platform/passwordKdf.native'
import { AccountScreen } from '../app/screens/AccountScreen'
import { ThemeProvider } from '../app/theme/ThemeContext'
import type { Session } from '../common/api'
import { TeamStationClient } from '../common/api'
import { calibratePasswordCosts } from '../common/passwordCalibration'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS
} from '../common/passwordProtocol'

function PasswordBenchmark(): React.ReactElement {
  const [form, setForm] = useState<{
    client: TeamStationClient
    session: Session
  }>()
  const [output, setOutput] = useState('Ready')
  const [url, setUrl] = useState('')
  const [iterations, setIterations] = useState(
    String(DEFAULT_PASSWORD_COSTS.iterations)
  )
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    setBusy(true)
    setOutput('Hashing')
    try {
      const calibration = await calibratePasswordCosts(passwordKdf, {
        ...DEFAULT_PASSWORD_COSTS,
        iterations: Number(iterations)
      })
      const p = clientParameters(
        '000102030405060708090a0b0c0d0e0f',
        calibration.costs
      )
      const vectorParameters = clientParameters(p.salt, {
        memoryKiB: 32768,
        iterations: 6,
        parallelism: 4
      })
      const vector = await passwordKdf('Argon2 parity: é😀', vectorParameters)
      await passwordKdf('Simulator benchmark password', p)
      const samples: number[] = []
      for (let i = 0; i < 3; i++) {
        const start = performance.now()
        await passwordKdf('Simulator benchmark password', p)
        samples.push(Math.round(performance.now() - start))
      }
      const result: Record<string, unknown> = {
        baselineMs: calibration.baselineMs,
        parameters: p,
        vector,
        samples,
        median: [...samples].sort((a, b) => a - b)[1]
      }
      if (url !== '') {
        const fixture = await (await fetch(url + '/benchmark')).json()
        const client = new TeamStationClient({
          baseUrl: url + '/api/v1',
          token: fixture.token,
          passwordKdf,
          passwordCosts: p
        })
        await client.setAccountPassword(
          'Simulator-only invented password',
          undefined,
          undefined,
          Promise.resolve(calibration.costs)
        )
        const session = await client.signInWithPassword(
          fixture.email,
          'Simulator-only invented password'
        )
        result.signedIn = session.user.id === fixture.userId
        await fetch(url + '/benchmark/result', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(result)
        })
      }
      setOutput(JSON.stringify(result))
    } catch (error) {
      setOutput(String(error))
    } finally {
      setBusy(false)
    }
  }
  const showForm = (mode: 'normal' | 'pending' | 'failure'): void => {
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      passwordKdf: async (password, parameters) => {
        if (mode === 'failure')
          throw new Error('Password preparation unavailable')
        if (mode === 'pending')
          await new Promise(resolve => setTimeout(resolve, 60000))
        return await passwordKdf(password, parameters)
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            user: {
              id: 101,
              displayName: 'Demo',
              isAdmin: false,
              avatarUrl: null
            },
            emails: [],
            hasPassword: false,
            passwordNeedsUpgrade: false,
            passwordParameters: null,
            newPasswordSalt: '00'.repeat(16)
          })
        )
    })
    setForm({
      client,
      session: {
        token: '',
        expiresAt: '',
        user: { id: 101, displayName: 'Demo', isAdmin: false, avatarUrl: null }
      }
    })
  }
  if (form != null)
    return (
      <SafeAreaProvider>
        <ThemeProvider>
          <AccountScreen
            client={form.client}
            session={form.session}
            onSignOut={() => {
              setForm(undefined)
            }}
          />
        </ThemeProvider>
      </SafeAreaProvider>
    )
  return (
    <ScrollView contentContainerStyle={{ padding: 35, gap: 20 }}>
      <Text>Native Argon2id benchmark</Text>
      <TextInput
        testID="benchmark-server"
        accessibilityLabel="Benchmark server"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
      />
      <TextInput
        testID="benchmark-iterations"
        accessibilityLabel="Iterations"
        value={iterations}
        onChangeText={setIterations}
        keyboardType="number-pad"
      />
      <Button
        title="Show password form"
        onPress={() => {
          showForm('normal')
        }}
      />
      <Button
        title="Show pending password form"
        onPress={() => {
          showForm('pending')
        }}
      />
      <Button
        title="Show failed password form"
        onPress={() => {
          showForm('failure')
        }}
      />
      <Button
        title="Run benchmark"
        disabled={busy}
        onPress={() => {
          run().catch((error: unknown) => {
            setOutput(String(error))
          })
        }}
      />
      <Text selectable accessibilityLabel="Benchmark result">
        {output}
      </Text>
    </ScrollView>
  )
}
AppRegistry.registerComponent('TeamStation', () => PasswordBenchmark)
