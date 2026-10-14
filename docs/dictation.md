# Dictation

A sentence the scorer says is read by the prompt in
[`src/server/dictation/interpreter.ts`](../src/server/dictation/interpreter.ts)
and checked, against Claude Haiku, by the integration tests.

## A phrase in the prompt is an integration test

When a sentence scores wrong and the prompt is changed because of it, add
that sentence to the integration tests in the same change. One test per
sentence, in
[`src/server/dictation/promptCases.integration.ts`](../src/server/dictation/promptCases.integration.ts),
using the invented players already in that file.

Then run every dictation integration test. A prompt written for one sentence
changes how the others are read.

```sh
node_modules/.bin/mocha -r sucrase/register --extension ts --timeout 180000 \
  'src/server/dictation/**/*.integration.ts'
```

The key is `dictation.anthropic` in `serverConfig.json`, which is not in git.
The file skips without it, so a finished run is the one whose tests passed.

These tests call Haiku and check the actions it returns. `*.test.ts` is the unit
run (`npm test`). `*.e2e.ts` launches the app. A sentence whose reply cannot
be scored is said once more by the file. A reply that scores the wrong play
fails.
