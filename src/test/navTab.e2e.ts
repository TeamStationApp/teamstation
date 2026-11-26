import { type NavTabId, navTabId } from '../app/components/tabBarModel'

export { navTabId }

export function navTabCss(id: NavTabId): string {
  return `[data-testid="${navTabId(id)}"]`
}

interface TabDevice {
  tapOn: (selector: { id: string }) => Promise<unknown>
  assertVisible: (selector: {
    id: string
    selected: boolean
    timeout: number
  }) => Promise<unknown>
}

export async function navTabSelected(
  device: Pick<TabDevice, 'assertVisible'>,
  id: NavTabId
): Promise<void> {
  await device.assertVisible({
    id: navTabId(id),
    selected: true,
    timeout: 15000
  })
}

export async function navTab(device: TabDevice, id: NavTabId): Promise<void> {
  await device.tapOn({ id: navTabId(id) })
  await navTabSelected(device, id)
}
