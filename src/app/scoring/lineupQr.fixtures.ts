/**
 * GameChanger lineup QR codes, as GameChanger's "Share your lineup" makes
 * them, rebuilt with MLB players' names and fresh ids. Each `text` was
 * encoded by Python's zlib (raw DEFLATE, `wbits=-15`), not by this app, so
 * the decoder is held to another encoder's output.
 *
 * 1. A half-built lineup: six batters, two fielders with plain codes in `n`.
 * 2. Eleven batters with a DH and an EH; the leadoff man is
 *    `rosterEditFixture`'s Mookie Betts #1.
 * 3. The same, made with a bench player on the team, who is left out.
 * 4. A pitcher (104) whose DH bats for him; no `rosterEditFixture` names.
 */
import type { GameChangerLineup } from './lineupQrCodec'

export interface LineupQrFixture {
  lineup: GameChangerLineup
  text: string
}

export const lineupQrFixture1: LineupQrFixture = {
  lineup: {
    e: 'a6deca95-bec2-49a4-b5b0-124ec6348ff6',
    t: '7b3b7105-366e-415e-9050-2bccd16ac3b6',
    h: [
      {
        i: 'cbb7fbcf-dbfc-44d4-a697-e4850ff715a1',
        f: 'Corey',
        l: 'Seager',
        n: '5',
        p: 2
      },
      {
        i: '083212df-25e4-468b-94f4-ddc07ec5ff12',
        f: 'Marcus',
        l: 'Semien',
        n: '2',
        p: 10
      },
      {
        i: '10c440e0-341f-4dd2-8223-fbeb52921f4a',
        f: 'Gerrit',
        l: 'Cole',
        n: '45',
        p: 4
      },
      {
        i: '8e7baf14-171d-4644-ad53-51713f052361',
        f: 'Ronald',
        l: 'Acuna',
        n: '13',
        p: 7
      },
      {
        i: '8710ec44-abb2-4ca6-a13c-ad1e38f0f413',
        f: 'Julio',
        l: 'Urias',
        n: '7',
        p: 6
      },
      {
        i: '09fb9aff-0cec-4f95-a75a-90aa36b30269',
        f: 'Pete',
        l: 'Alonso',
        n: '20',
        p: 3
      }
    ],
    n: [
      {
        i: '1d26ae1a-f7a5-4a22-b737-909f28808268',
        f: 'Spencer',
        l: 'Strider',
        n: '99',
        p: 1
      },
      {
        i: '772df7da-44f8-4c0c-bff5-05e2be1612a7',
        f: 'Kyle',
        l: 'Tucker',
        n: '30',
        p: 8
      }
    ]
  },
  text: 'PdJNb9swDAbg/+JzCUgU9eHehh4GbBgwrNtp6IGSyM6YZxdOciiK/PcpiZyTJUN6QPHlxyDD48ChSuHRQ5aCQCMTZJ8NWCQpwVFSDcPDcGxHY3Y5WuPBhSBA1guMxhvAXEq1gYvLl6N/hsffH8PULpSco+aiULMWIKoEHMYIQskb1Wg923ZB29GndZP3tp7b+ln4Vba2WdrGt+/b8Ijnh5tpkkOLVQG9EFBIGUZSglqLiVK8qsVufuOtnA539N8kS0fxhlqzq9YUIiMGHFkFqhUhITrQLNnjiFaJu/pZtm06dvVpnaWb1Cul3UwSM6slsNHWVim111fvwLe9U+PRhf31P9aF59rNT+W0cEetu6HxjrYApFyonFtchQOwdaXJVlxSo3S9ckG/nOZp7eavbeJDN+ONDPeOjppHVgVTpKWkbRY4em7ZMruQncEwdvK7HGWvcl6Xw7r309xMd365/uj524qBxTJoZA/EiJCji00eFVMyCUPq8vObLOUa+jWs4zbV+wiMY49rrzjGNgCxchspTa0JpkBW9WC8YBYbLHLs7tf3ea/456n8vZuuV5zOL+f/'
}

export const lineupQrFixture2: LineupQrFixture = {
  lineup: {
    e: 'a6deca95-bec2-49a4-b5b0-124ec6348ff6',
    t: '7b3b7105-366e-415e-9050-2bccd16ac3b6',
    h: [
      {
        i: 'c736afa8-fef6-42c3-866b-dac0683168ad',
        f: 'Mookie',
        l: 'Betts',
        n: '1',
        p: 6
      },
      {
        i: 'c78cdf0e-34cf-4b1a-89a0-6c29f96951dc',
        f: 'Corey',
        l: 'Seager',
        n: '5',
        p: 2
      },
      {
        i: 'b6c257d4-eb02-405a-b1d4-a464af89bf78',
        f: 'Pete',
        l: 'Alonso',
        n: '20',
        p: 1
      },
      {
        i: '51b4b29d-fd2c-4114-9733-19c1ba4e2f5b',
        f: 'Marcus',
        l: 'Semien',
        n: '2',
        p: 10
      },
      {
        i: '344e6398-cb01-4bc7-a0e6-9d6bcc2f4d88',
        f: 'Kyle',
        l: 'Tucker',
        n: '30',
        p: 8
      },
      {
        i: '95583970-94a2-4174-b6d2-57b417d4be87',
        f: 'Matt',
        l: 'Olson',
        n: '28',
        p: 3
      },
      {
        i: '34f8f0c6-ff98-4321-8191-d5f60ca0e06a',
        f: 'Will',
        l: 'Smith',
        n: '16',
        p: 5
      },
      {
        i: '772ce3bb-3734-45e3-b536-887ffee68aa5',
        f: 'Jose',
        l: 'Altuve',
        n: '27',
        p: 7
      },
      {
        i: '4fc5ef45-2b83-4066-921b-cc62f46fdd62',
        f: 'Gerrit',
        l: 'Cole',
        n: '45',
        p: 4
      },
      {
        i: '23784d7a-f28b-4309-9ac4-c81b91a1e386',
        f: 'Rafael',
        l: 'Devers',
        n: '11',
        p: 12
      },
      {
        i: '5de847af-0bcc-4920-ac53-29f117c1f607',
        f: 'Yordan',
        l: 'Alvarez',
        n: '44',
        p: 11
      }
    ],
    n: []
  },
  text: 'RZNdaxUxEIb/y153IB+TSdI7rSAooqggUnqRj4k9dHtW9mwLtfS/O3qS7dVmlsnD+868eZ54upwSVS4pOshcDGBMCNllBdogF7IYWqPpYtqk1WebvVYOLBEDascQlVNgcilVUyo2/2u9nS6vn6eDXCjeUmopQONGgKZYCEQZaiqKgtUUUpULTVo/LcvdgaWYpXjL23aS81HOWr6/p0t6uRjMUGpTDBZLA8w6QYhJARUTW6TodC2debWs/NSR3zj94rUz3ZlpBjPLZecrAmclM1AuQdZSJiRMLcTcfOjML7wNlW/m5XhaOtKoM1MPptMZs4kVWjVFhqURorcWdCw6J2TTXB7e01oeTrvQ+wMfB7VD1aBaRCYbA5SstLgvHpJiglhJlmAa1jCUfnyah9LvD+VuN2+70jCY0blgo1cQMYl77SUBVA04n6WomDn4Xem2debn+bTsMsMZaV9lttBUIWhNtKI1GoKOGqprpIooVpQ68sdhnof1+8N2O9ZOZ6QbSO9NYZszWG8R0LGVnFqCEHxrzBKl5Dryw3J63dH28MhDpj8z/WBiK44bOklwsLJ3kkEanaEUklFSq5VMZ77ndT0M71fLPJjYs4SDaawPWH2CZkIW6ypCTAWhBJ2jTpptoM78Km+Dh/l3/MjrHvqeer1H1FUO6FMDJXuWZ2oUpOIsSOi19kXLXMeSfi5rTcd9AI9p5T9DLXaufrn5/+f65uUv'
}

export const lineupQrFixture3: LineupQrFixture = {
  lineup: {
    e: 'a6deca95-bec2-49a4-b5b0-124ec6348ff6',
    t: '7b3b7105-366e-415e-9050-2bccd16ac3b6',
    h: [
      {
        i: 'adb7640e-3117-42d7-becb-725b184fe7c5',
        f: 'Mookie',
        l: 'Betts',
        n: '1',
        p: 6
      },
      {
        i: 'dbe29fe7-b178-4448-a5b7-de6817824711',
        f: 'Corey',
        l: 'Seager',
        n: '5',
        p: 2
      },
      {
        i: 'b8acbf0a-8d30-4333-81af-a18130e1ebc3',
        f: 'Pete',
        l: 'Alonso',
        n: '20',
        p: 1
      },
      {
        i: 'a2fce135-8a24-44f4-a563-c44b66f07b4f',
        f: 'Marcus',
        l: 'Semien',
        n: '2',
        p: 10
      },
      {
        i: '212c2351-9d28-4c6c-a6e4-04628115a8f4',
        f: 'Kyle',
        l: 'Tucker',
        n: '30',
        p: 8
      },
      {
        i: '64b47a02-665a-42c6-a832-da55ac11cbdd',
        f: 'Matt',
        l: 'Olson',
        n: '28',
        p: 3
      },
      {
        i: '2e44cf79-a6d4-441f-bff9-0df635983240',
        f: 'Will',
        l: 'Smith',
        n: '16',
        p: 5
      },
      {
        i: '5b53b581-7abf-452d-8e67-26be481082f2',
        f: 'Jose',
        l: 'Altuve',
        n: '27',
        p: 7
      },
      {
        i: 'd46355da-75af-4b01-abf5-7e11744eded5',
        f: 'Gerrit',
        l: 'Cole',
        n: '45',
        p: 4
      },
      {
        i: '040c935c-376f-42a9-bd12-45e071d4a8be',
        f: 'Rafael',
        l: 'Devers',
        n: '11',
        p: 12
      },
      {
        i: '3242de59-8563-4612-8493-0310dbce0575',
        f: 'Yordan',
        l: 'Alvarez',
        n: '44',
        p: 11
      }
    ],
    n: []
  },
  text: 'RdPfi9QwEAfw/6XPN5BJJj+6b3qCoIiigshxD5lk4i3X20q3t3Ae+7+bdZP61DQkn34nmb4OMuyG6LKkOFpgSRpojARsWQFqkuQMhVLccDOsdalnwx6VBeOcAKEVGJVVoDmljC4mw5elD8Pu7nXYX+zM3pESMIgeSGd/+QqD15YxUBGfbN1Q6tJP8/y4l/oy1Ze3sq7HOj7UMdbn72HnzjdXM7Pose4ERh+AiAJEyx6yuFBnNHnEZt7Oi7w08pvEX7I0015N3U0OMXFREUI2CsgYAwFjgYgBjRIUTqaZX2TtKd9M8+E4N1Krq4ndjLokQWMhRE01Z6Ga0xlIROxcUZ6p9Nrjkp6PW9CnvRy62lDVVY06aWMRxqxr9ckliE4IFDkdEG0MhZr68WXqSb8/p8eteNOShm46YvJRaXDOxnpLyUEMRkOO1saEmDjnLem6NvPzdJy3mOFKmi2mEKXixxouX4rHAlzKCCoXZ+xYdVKN/LGfpl7603596NfurqTtpGVr2AYEH7kAWZ0hiPOgHQsFVEEX3cgP8/H/Ha3PJ+kx/dX0Wy9RTWNzBG/rbRMrhIpb8FL7lUiy5N6f72VZ9r3223nqJrVeom4qUmk0NoHxrpo6jsAZ659lRXnMFANLM7/GEqUX/05OsmxN37oetxatJ6az2BHCpYnIVTHQaEAZVJmTKOt71J/zkuNhO4BTXORPT0vNxfP9v5m7+/Nf'
}

export const lineupQrFixture4: LineupQrFixture = {
  lineup: {
    e: 'a6deca95-bec2-49a4-b5b0-124ec6348ff6',
    t: '7b3b7105-366e-415e-9050-2bccd16ac3b6',
    h: [
      {
        i: 'a3d7b3de-c6da-44d8-b900-dadd1058c0ea',
        f: 'Corey',
        l: 'Seager',
        n: '5',
        p: 6
      },
      {
        i: '2521e882-8cae-4945-8bee-9114af56deaa',
        f: 'Marcus',
        l: 'Semien',
        n: '2',
        p: 2
      },
      {
        i: '0cb42de5-2c35-4437-98e4-c875ddd9a43c',
        f: 'Pete',
        l: 'Alonso',
        n: '20',
        p: 1
      },
      {
        i: 'fe53ecd2-eb39-49bb-a2a4-fccc1dae528b',
        f: 'José',
        l: 'Ramírez',
        n: '11',
        p: 10
      },
      {
        i: '2cf7f72f-a232-4501-a29a-78f8d87438c0',
        f: 'Kyle',
        l: 'Tucker',
        n: '30',
        p: 8
      },
      {
        i: 'e6842d2b-c6f0-477d-85bd-4b2676c2f6fc',
        f: 'Matt',
        l: 'Olson',
        n: '28',
        p: 3
      },
      {
        i: '49b1ad6c-2976-4fa8-920c-048f7e69158b',
        f: 'Will',
        l: 'Smith',
        n: '16',
        p: 5
      },
      {
        i: 'b36eb078-d071-48b4-bcac-77b102c61511',
        f: 'Jose',
        l: 'Altuve',
        n: '27',
        p: 7
      },
      {
        i: '4161819f-4660-4551-9d94-bab7adbf9e4a',
        f: 'Rafael',
        l: 'Devers',
        n: '33',
        p: 12
      },
      {
        i: '736715e4-ad90-41ed-b1a1-6af7aac66b40',
        f: 'Yordan',
        l: 'Alvarez',
        n: '44',
        p: 12
      },
      {
        i: '6107f57b-393b-4718-b197-f0b08a47862d',
        f: 'Cal',
        l: 'Raleigh',
        n: '29',
        p: 11
      }
    ],
    n: [
      {
        i: '70663806-3826-40a2-950a-c5be7a220908',
        f: 'Gerrit',
        l: 'Cole',
        n: '45',
        p: 104
      }
    ]
  },
  text: 'XZNNahwxEIXv0msX6LckeRccCCSEBCcQQvCiJJXsIe2Z0DM2OGYOlEVO4Yul7JHakFWXGunj1XtVjxNP5xNh5ULJQ+ZiwCVykH1WoI3jgtbF1nA6mw5yNWSbg1YeLCKD054hKa/A5FKqRio2P1+9mc5/PE6bZ7at8qYyFKwEztUIOSkFlWoVTiyKSR40uXqxW/hB6lnqL0zXvMhhKwcv31/TOR7PTkzjjeYYDcRCIiI5DzGzKNHaUfPSDQ3mR1rK3X6F3m5426HmBDUDqkp2prIHU6wXoTZAiuygxOBrrWKKLR36mQ/ckW/m3Xa/G0h1YurBbOwtl2qAs00iNGcgI+62UoquxN7E3Jnvd/unPx16SbdPfxf+3bFad6xaDSgttGCa0KwE5pWWKhGE2GKNwVmxtXM/PMxD69e78nP11HatcTAZo/RvsgTVFLgQKkSfK7hsMGAxDVtZTT0cOvPTvN+tjsYT0g6kNKypYgGTAoJrFCEZVUDJRAXGpP3a/rfNPI+UbjeHm9E6npB+ILNFzipEqCpocDHLqBYqEELWyhTU/sWt7uhrSoe7ex4yw4kZVpkaddSpgUOUzr3XkGoSMOVANbfEbozTJTXiIfQt3/OyH37aHtI6UMFikP1wQDUJVnMFsUMDUgtEBTG7EdL33VJpu4q9p9fwnfufi1qF5kMGm2yWoLRslE4BmsoqkgsRTR0bRfM6UjNvroetJnWoPl69/OnLGhSijQrBRiOBKTKQvCIoPnMgY1RSsaPf8bJsxhRc7ObhrvNjWN3x6vgP'
}
