/**
 * Reads and turns an iOS picker wheel through maestro-d, which has no picker
 * command: the app's `UIPickerView` (the pop-up `Wheel`) and Safari's time
 * wheel alike. Both are `PickerWheel` nodes in the hierarchy. The app's wheel
 * reads its row's label, then a comma and more; Safari's reads `11 o’clock`,
 * `30 minutes`, `AM`. A tap one row above or below the selection band, at the
 * wheel's vertical centre, turns it one row.
 */
export interface WheelNode {
  type?: string
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: WheelNode[]
}

interface WheelDriver {
  hierarchy: () => Promise<unknown>
  tapOn: (args: Record<string, unknown>) => Promise<unknown>
  waitForAnimationToEnd: (args?: Record<string, unknown>) => Promise<unknown>
}

const flatten = (node: WheelNode): WheelNode[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

/** Every wheel on the screen, left to right. */
export function pickerWheels(root: WheelNode): WheelNode[] {
  return flatten(root)
    .filter(node => node.type === 'PickerWheel' && node.bounds != null)
    .sort((a, b) => a.bounds!.x - b.bounds!.x)
}

/**
 * The row a wheel has settled on, as it reads. A row's label can hold a comma
 * ("First name, last initial"), so with `options` it is the longest option the
 * text is, or begins with before a comma; without them, the text up to its
 * first comma.
 */
export function wheelValue(
  node: WheelNode,
  options: readonly string[] = []
): string {
  const text = node.text ?? ''
  const matched = options
    .filter(option => text === option || text.startsWith(`${option}, `))
    .sort((a, b) => b.length - a.length)[0]
  return matched ?? text.split(', ')[0]
}

/** The `index`th wheel on the screen now (left to right). */
export async function wheelAt(m: WheelDriver, index = 0): Promise<WheelNode> {
  const wheels = pickerWheels((await m.hierarchy()) as WheelNode)
  const wheel = wheels[index]
  if (wheel == null)
    throw new Error(`Expected wheel ${index}, found ${wheels.length}`)
  return wheel
}

/**
 * Turns the wheel `find` answers until it reads `target`, one row at a time.
 * `options` are the wheel's values in the order it shows them, in the terms
 * `wheelValue` answers: the wheel does not wrap, so it turns down while the
 * row it reads comes before `target` and up while it comes after. A reading
 * that is none of `options` fails at once.
 */
export async function turnWheel(
  m: WheelDriver,
  find: () => Promise<WheelNode>,
  target: string,
  options: readonly string[],
  { rowPoints = 33, maxSteps = 60 } = {}
): Promise<void> {
  const goal = options.indexOf(target)
  if (goal < 0) throw new Error(`${target} is not one of the options`)
  let last = ''
  for (let step = 0; step <= maxSteps; step++) {
    const wheel = await find()
    last = wheelValue(wheel, options)
    if (last === target) return
    const at = options.indexOf(last)
    if (at < 0)
      throw new Error(
        `The wheel reads ${JSON.stringify(wheel.text)}, none of the options`
      )
    const { x, y, width, height } = wheel.bounds!
    const down = at < goal
    await m.tapOn({
      point: `${Math.round(x + width / 2)},${Math.round(
        y + height / 2 + (down ? rowPoints : -rowPoints)
      )}`
    })
    await m.waitForAnimationToEnd({ timeout: 2000 })
  }
  throw new Error(`The wheel stopped at ${last}, not ${target}`)
}
