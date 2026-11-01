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
  export interface ArchiveOptions {
    workspace?: string
    scheme: string
    configuration?: string
    buildNumber?: string
  }
  export interface ArchiveResult {
    archive: string
    ipa?: string
    dsyms: string
  }
  export interface Stage {
    sh: (command: string, options?: CommandOptions) => Promise<CommandResult>
    getBuildNumber: (key: string) => string
    stash: (name: string, paths: string | string[]) => Promise<void>
    unstash: (name: string) => Promise<void>
    artifacts: {
      save: (name: string, paths: string | string[]) => Promise<void>
    }
    apple: {
      archive: (options: ArchiveOptions) => Promise<ArchiveResult>
    }
  }
  export interface NodeSelector {
    type: string
    os?: string
    arch?: string
    labels?: readonly string[]
  }
  export interface StageOptions {
    name?: string
    on: NodeSelector
    tools?: Record<string, unknown>
    timeout?: string
    publishes?: string[]
    buildNumbers?: string[]
    cache?: Array<{ key: string; paths: string[] }>
    apple?: { distribution: string; app: string }
    run: (ctx: Stage) => Promise<void>
  }
  export interface Setup {
    apiVersion: (version: 1) => void
    buildNumber: (
      key: string,
      options?: { format?: string; timeZone?: string }
    ) => void
    parallel: (
      name: string,
      members: Record<string, StageOptions | StageOptions[]>
    ) => unknown
  }
}
