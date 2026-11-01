// Ambient types for the pipeline Masonfile. @mason/types is not published;
// Mason erases the import when it runs the file.
declare module '@mason/types' {
  export interface CommandResult {
    code: number
    stdout: string
    stderr: string
  }
  export interface CommandOptions {
    cwd?: string
    env?: Record<string, string>
    /** Resolve instead of rejecting on a nonzero exit. */
    allowFailure?: boolean
  }
  export interface Stage {
    sh: (command: string, options?: CommandOptions) => Promise<CommandResult>
    getBuildNumber: (key: string) => string
    artifacts: {
      save: (name: string, paths: string | string[]) => Promise<void>
    }
  }
  export interface StageOptions {
    on: { type: string; os: string; arch: string }
    tools: Record<string, unknown>
    timeout?: string
    publishes?: string[]
    buildNumbers?: string[]
    cache?: Array<{ key: string; paths: string[] }>
    run: (ctx: Stage) => Promise<void>
  }
  export interface Setup {
    apiVersion: (version: 1) => void
    buildNumber: (
      key: string,
      options?: { format?: string; timeZone?: string }
    ) => void
    parallel: (name: string, members: Record<string, StageOptions>) => unknown
  }
}
