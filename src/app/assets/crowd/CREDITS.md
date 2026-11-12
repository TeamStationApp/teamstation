# Crowd sounds

Every file here is cut from a recording its author dedicated to the public
domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),
taken from that recording's Freesound preview and made mono, 44.1 kHz AAC at
96 kbit/s with FFmpeg.

| File | Source | Cut |
| --- | --- | --- |
| `crowd-idle.m4a` | [Freesound 438397](https://freesound.org/s/438397/), "Large baseball-type crowd", CC0 | 18–40 s, played as two overlapping copies crossfaded over 2 s by the player, loudness −30 LUFS |
| `cheer-small.m4a` | [Freesound 651646](https://freesound.org/s/651646/), crowd cheering, CC0 | 0–2.5 s, −20 LUFS |
| `cheer-medium.m4a` | [Freesound 486214](https://freesound.org/s/486214/), crowd cheering and whistling, CC0 | 20–24 s, −20 LUFS |
| `cheer-large.m4a` | [Freesound 480765](https://freesound.org/s/480765/), very large crowd cheering, CC0 | 8–13 s, −20 LUFS |
| `cheer-huge.m4a` | [Freesound 397434](https://freesound.org/s/397434/), crowd cheering a win, CC0 | 0.3–7.3 s, −20 LUFS |

The idle crowd, a plain cut with no fades of its own:

```sh
ffmpeg -ss 18 -t 22 -i 438397.mp3 -af "pan=mono|c0=0.5*c0+0.5*c1,loudnorm=I=-30:TP=-2:LRA=7" -ar 44100 -ac 1 -c:a aac -b:a 96k crowd-idle.m4a
```

Each cheer, with `<start>`, `<length>` and `<length − 1.2>` from the table:

```sh
ffmpeg -ss <start> -t <length> -i <source>.mp3 -af "pan=mono|c0=0.5*c0+0.5*c1,afade=t=in:d=0.15,afade=t=out:st=<length − 1.2>:d=1.2,loudnorm=I=-20:TP=-1.5:LRA=7" -ar 44100 -ac 1 -c:a aac -b:a 96k cheer-<size>.m4a
```
