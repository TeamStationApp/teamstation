/** Simulator-only entry point. Build explicitly with ENTRY_FILE; never used by the product. */
import React, { useState } from 'react'
import { AppRegistry, Button, ScrollView, Text, TextInput } from 'react-native'

import { passwordKdf } from '../app/platform/passwordKdf.native'
import { TeamStationClient } from '../common/api'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS
} from '../common/passwordProtocol'

function PasswordBenchmark(): React.ReactElement {
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
      const p = clientParameters('000102030405060708090a0b0c0d0e0f', {
        memoryKiB: 65536,
        iterations: Number(iterations),
        parallelism: 1
      })
      const vectorParameters = clientParameters(p.salt, {
        memoryKiB: 19456,
        iterations: 2,
        parallelism: 1
      })
      const vector = await passwordKdf('Argon2 parity: é😀', vectorParameters)
      await passwordKdf('Simulator benchmark password', p)
      const samples: number[] = []
      for (let i = 0; i < 5; i++) {
        const start = performance.now()
        await passwordKdf('Simulator benchmark password', p)
        samples.push(Math.round(performance.now() - start))
      }
      const result: Record<string, unknown> = {
        parameters: p,
        vector,
        samples,
        median: [...samples].sort((a, b) => a - b)[2]
      }
      if (url !== '') {
        const fixture = await (await fetch(url + '/benchmark')).json()
        const client = new TeamStationClient({
          baseUrl: url + '/api/v1',
          token: fixture.token,
          passwordKdf,
          passwordCosts: p
        })
        await client.setAccountPassword('Simulator-only invented password')
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
