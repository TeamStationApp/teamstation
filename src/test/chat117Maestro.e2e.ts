import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface HierarchyNode {
  type?: string
  id?: string
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: HierarchyNode[]
}

export interface MaestroDevice {
  hideKeyboard: () => Promise<unknown>
  openLink: (options: Record<string, unknown>) => Promise<unknown>
  tapOn: (options: Record<string, unknown>) => Promise<unknown>
  inputText: (options: Record<string, unknown>) => Promise<unknown>
  assertVisible: (options: Record<string, unknown>) => Promise<unknown>
  screenshot: () => Promise<Buffer>
  hierarchy: () => Promise<HierarchyNode>
}

export const flatten = (node: HierarchyNode): HierarchyNode[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

export function maestroClient(): {
  MaestroD: {
    connect: (options: Record<string, unknown>) => Promise<{
      attach: (options: Record<string, unknown>) => Promise<MaestroDevice>
    }>
  }
} {
  const root = resolve(
    process.env.MAESTRO_D_CLIENT_ROOT ??
      join(homedir(), 'git', 'maestro-d', 'npm', 'maestro-d')
  )
  return createRequire(join(root, 'package.json'))('maestro-d')
}
