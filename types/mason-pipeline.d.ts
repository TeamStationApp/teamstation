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
    project?: string
    scheme: string
    configuration?: string
    destination?: string
    sdk?: string
    /** Sets MARKETING_VERSION. One to three numeric components. */
    version?: string
    buildNumber?: string
    /** Extra arguments passed to xcodebuild, including build settings. */
    xcargs?: string[]
    /** Added to xcodebuild's environment, which the project's build scripts see. */
    env?: Record<string, string>
  }
  export interface ArchiveResult {
    archive: string
    ipa?: string
    app?: string
    pkg?: string
    dsyms: string
  }
  export interface ResignResult {
    ipa: string
  }
  export interface TestflightResult {
    buildId: string
    version: string
    buildNumber: string
    state: string
  }
  export interface Stage {
    workspace?: string
    run: {
      branch: string
      /** The immutable source revision selected for this run. */
      commit: string
      /** The run's workflow parameters, as the master checked them. */
      params?: Readonly<Record<string, string | number | boolean>>
    }
    sh: (command: string, options?: CommandOptions) => Promise<CommandResult>
    getBuildNumber: (key: string) => string
    stash: (name: string, paths: string | string[]) => Promise<void>
    unstash: (name: string) => Promise<void>
    artifacts: {
      save: (name: string, paths: string | string[]) => Promise<void>
      fetch: (
        query: {
          workflow: string
          branch?: string
          status?: 'success'
          name: string
        },
        into: string
      ) => Promise<string[]>
    }
    fs: {
      glob: (patterns: string | string[]) => Promise<string[]>
    }
    publish: (options: {
      app: string
      platform: string
      path: string
      version?: string
      buildNumber?: string
    }) => Promise<void>
    apple: {
      archive: (options: ArchiveOptions) => Promise<ArchiveResult>
      resign: (options: {
        path: string
        /** Sets CFBundleShortVersionString. */
        version?: string
        /** Sets CFBundleVersion. */
        buildNumber?: string
      }) => Promise<ResignResult>
      testflight: (options: {
        path: string
        whatToTest?: string
        groups?: string[]
        usesNonExemptEncryption?: boolean
      }) => Promise<TestflightResult>
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
    /** Project secrets the stage's commands get in their environment. */
    secrets?: string[]
    apple?: {
      distribution: string
      app: string
      platform?: 'ios' | 'macos' | 'tvos'
    }
    checkout?: boolean | { depth?: number }
    /**
     * Skip the stage unless every listed field matches. `branch` entries are
     * globs; `params` must equal the run's parameters.
     */
    when?: {
      branch?: string[]
      params?: Record<string, string | number | boolean>
    }
    run: (ctx: Stage) => Promise<void>
  }
  export interface ParallelOptions {
    failFast?: boolean
  }
  export interface WorkflowBuilder {
    stage: (name: string, options: StageOptions) => void
    parallel: (
      name: string,
      members: Record<string, StageOptions | StageOptions[]>,
      options?: ParallelOptions
    ) => unknown
  }
  export interface ChoiceParam {
    type: 'choice'
    choices: string[]
    default?: string
  }
  export interface WorkflowOptions {
    triggers?: Array<{ request: true }>
    params?: Record<string, ChoiceParam>
    timeout?: string
  }
  export interface Setup {
    /** The branch this run builds. A caller that omits it stands in for master. */
    branch?: string
    /** The run's parameters. A caller that omits them stands in for the defaults. */
    params?: Readonly<Record<string, string | number | boolean>>
    apiVersion: (version: 1) => void
    buildNumber: (
      key: string,
      options?: { format?: string; timeZone?: string }
    ) => void
    parallel: (
      name: string,
      members: Record<string, StageOptions | StageOptions[]>,
      options?: ParallelOptions
    ) => unknown
    workflow: (
      name: string,
      options: WorkflowOptions,
      declare: (workflow: WorkflowBuilder) => void
    ) => void
  }
}
