/** Invented scoring examples shared by real-interpreter and reducer tests. */
export interface ChoicePhrase {
  runs?: number
  said: string
  mask: number
  startingOuts: number
  outs: number
  throws: number[][]
  credits: Array<[number, number, 'f_assist' | 'f_putout']>
}

export const choiceRelayPhrases: ChoicePhrase[] = [
  {
    said: "Ground ball to the third baseman for a fielder's choice. He steps on third himself to retire the runner from second, then throws to the second baseman at second and on to the first baseman at first, both throws too late. The runner from first is safe at second and the batter is safe at first.",
    mask: 3,
    startingOuts: 0,
    outs: 1,
    throws: [
      [15, 15],
      [15, 13],
      [13, 12]
    ],
    credits: [[7, 15, 'f_putout']]
  },
  {
    said: "Ground ball to the third baseman for a fielder's choice. He tags the runner from second out at third himself, then tags the runner from first out at second himself. He then throws to the first baseman, too late to get the batter, who is safe at first.",
    mask: 3,
    startingOuts: 0,
    outs: 2,
    throws: [
      [15, 15],
      [15, 15],
      [15, 12]
    ],
    credits: [
      [7, 15, 'f_putout'],
      [6, 15, 'f_putout']
    ]
  },
  {
    said: "Ground ball to the third baseman for a fielder's choice. He throws to the second baseman at second, then to the first baseman at first. Both throws are late. All runners are safe, each advancing one base, the runner from third scores, and the batter is safe at first.",
    mask: 7,
    startingOuts: 0,
    outs: 0,
    throws: [
      [15, 13],
      [13, 12]
    ],
    credits: []
  },
  {
    said: "Ground ball to the third baseman for a fielder's choice. He throws to the second baseman at second, back to the third baseman at third, then back to the second baseman at second. All throws are late, the runner from first is safe at second, and the batter is safe at first.",
    mask: 1,
    startingOuts: 0,
    outs: 0,
    throws: [
      [15, 13],
      [13, 15],
      [15, 13]
    ],
    credits: []
  },
  {
    said: "Ground ball to the third baseman for a fielder's choice. He steps on third himself to retire the runner from second, then throws to the second baseman for the out at second on the runner from first. The second baseman throws to the first baseman, but the batter is safe at first because that last throw is late.",
    mask: 3,
    startingOuts: 0,
    outs: 2,
    throws: [
      [15, 15],
      [15, 13],
      [13, 12]
    ],
    credits: [
      [7, 15, 'f_putout'],
      [6, 15, 'f_assist'],
      [6, 13, 'f_putout']
    ]
  },
  {
    said: "Ground ball to the third baseman for a fielder's choice. He throws to the catcher for the force out at home on the runner from third. The catcher throws to the second baseman at second and on to the first baseman at first, both throws late. The runner from second is safe at third, the runner from first is safe at second, and the batter is safe at first.",
    mask: 7,
    startingOuts: 0,
    outs: 1,
    throws: [
      [15, 11],
      [11, 13],
      [13, 12]
    ],
    credits: [
      [8, 15, 'f_assist'],
      [8, 11, 'f_putout']
    ]
  }
]

export const choiceTimingPhrases: ChoicePhrase[] = [
  {
    said: "Grounder to the third baseman for a fielder's choice. The runner on third scores before the runner on second is tagged out at third by the third baseman himself. The batter reaches first safely.",
    mask: 6,
    startingOuts: 2,
    runs: 1,
    outs: 1,
    throws: [[15, 15]],
    credits: [[7, 15, 'f_putout']]
  },
  {
    said: "Grounder to the third baseman for a fielder's choice. With two outs, he tags the runner on second out at third himself. Only after that third out does the runner from third cross home. The batter reaches first safely.",
    mask: 6,
    startingOuts: 2,
    runs: 0,
    outs: 1,
    throws: [[15, 15]],
    credits: [[7, 15, 'f_putout']]
  }
]

export const choiceOccupancyPhrases: ChoicePhrase[] = []
for (let mask = 1; mask < 8; mask++)
  for (const startingOuts of [0, 1, 2]) {
    const runners = [8, 7, 6].filter(id => (mask & (1 << (id - 6))) !== 0)
    for (let subset = 0; subset < 1 << runners.length; subset++) {
      const calls: string[] = []
      const credits: ChoicePhrase['credits'] = []
      const throws: number[][] = []
      let outs = startingOuts
      for (const [index, id] of runners.entries()) {
        if (outs >= 3) break
        const from = ['first', 'second', 'third'][id - 6]
        const to = ['second', 'third', 'home'][id - 6]
        if ((subset & (1 << index)) !== 0) {
          calls.push(
            `The third baseman tags the runner from ${from} out himself at ${to}.`
          )
          outs++
          credits.push([id, 15, 'f_putout'])
          throws.push([15, 15])
        } else calls.push(`The runner from ${from} is safe at ${to}.`)
      }
      choiceOccupancyPhrases.push({
        said:
          "Ground ball to the third baseman for a fielder's choice. The batter is safe at first. " +
          calls.join(' '),
        mask,
        startingOuts,
        outs: outs - startingOuts,
        throws,
        credits
      })
    }
  }
