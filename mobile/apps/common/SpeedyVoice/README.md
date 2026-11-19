# SpeedyVoice

TS Speedy's spoken numbers. Both apps play these files: iOS as this package's
resources (`SpeedyVoice.clipURL`), Android as assets read from
`Sources/SpeedyVoice/Clips`.

## The clips

`Sources/SpeedyVoice/Clips` holds 242 WAVs, all PCM, 16-bit, mono, 24 kHz:

| Clip | What it is | Used for |
| --- | --- | --- |
| `n56-final` | "Fifty-six." said alone, falling at the end | a pitch with no exit: "56" |
| `n56-and` | "fifty-six" said before "and" | the pitch in "56 and 52 exit" |
| `n56-exit` | "fifty-six" said before "exit" | the exit in "53 exit" and "56 and 52 exit" |
| `word-and` | "and" | between the two numbers |
| `word-exit` | "exit." | the end of every phrase with an exit |

There are three takes of every number from 20 to 99, so a phrase built from
clips keeps the intonation it would have had if spoken whole. The apps join a
phrase's clips sample for sample, with no gap:

| Reading | Clips |
| --- | --- |
| pitch 56 | `n56-final` |
| exit 53 | `n53-exit`, `word-exit` |
| pitch 56, then exit 52 within 250 ms | `n56-and`, `word-and`, `n52-exit`, `word-exit` |

## How they were made

They come from xAI's text to speech (`POST https://api.x.ai/v1/tts`), voice
`rex` at normal speed (the voice TeamStation's replay announcer uses), as PCM
with per-character timestamps. They were made on 2026-11-18.

- `n<N>-final` is "Fifty-six." synthesized on its own.
- `n<N>-and` and `n<M>-exit` are cut from "Fifty-six and fifty-seven exit."
  Each number is followed by the next (99 by 20), so every number is said once
  before "and" and once before "exit".
- `word-and` and `word-exit` are cut from "Fifty-six and fifty-two exit."

A cut between two words falls at the quietest point in the later half of the
gap the timestamps leave. Each clip is then trimmed of silence below −45 dBFS,
keeping 8 ms, and faded in and out over 6 ms.

After the clips were made, every number alone and every number joined into a
phrase it was not cut from was transcribed with xAI's speech to text
(`--transcribe`, below): 160/160 came back with the right numbers and "exit".
"and" is not required of a transcript, because before "ninety…" it runs into the
next "n", as it does in natural speech.

A run writes the new clips beside `Clips/` and moves them in only when every
request has succeeded, so a failed run leaves the committed set untouched.

## Making them again

The key is never written to disk by these scripts.

```bash
XAI_API_KEY=… node scripts/generateClips.mjs --samples /tmp/speedy-samples   # all clips, plus 4 listening samples
node scripts/generateClips.mjs --check                                      # the committed set is complete and well formed
node scripts/generateClips.mjs --no-generate --samples /tmp/speedy-samples  # only the listening samples
XAI_API_KEY=… node scripts/generateClips.mjs --transcribe                   # speech-to-text check of the set; exits 1 on a miss
```

`scripts/clipJobs.mjs` holds the takes and the requests, and
`scripts/clipSlicer.mjs` the cutting. Their tests run without the network:

```bash
npx c8 --check-coverage --per-file --lines 90 \
  --include 'mobile/apps/common/SpeedyVoice/scripts/clipSlicer.mjs' \
  --include 'mobile/apps/common/SpeedyVoice/scripts/clipJobs.mjs' \
  node --test mobile/apps/common/SpeedyVoice/scripts/clipSlicer.test.mjs mobile/apps/common/SpeedyVoice/scripts/clipJobs.test.mjs
```
