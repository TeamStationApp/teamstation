import type { Page } from 'puppeteer'

export interface FixtureManifest {
  world: string
  nonce: string
  accounts: Record<
    string,
    { email: string; password: string; displayName: string; userId: string }
  >
  ids: Record<string, string>
}
export interface WebSession {
  m: any
  page: Page
  close: () => Promise<void>
}
export interface E2eContext {
  stack: { origin: string }
  artifact: (name: string) => string
  fixture: (name: string) => Promise<FixtureManifest>
  browser: (size: { width: number; height: number }) => Promise<WebSession>
  signIn: (role: string, m: any) => Promise<void>
  attach: (role: string, options: Record<string, unknown>) => Promise<any>
  checkpoint: (
    id: string,
    options: { readBack: () => Promise<void> },
    m?: any
  ) => Promise<void>
}
