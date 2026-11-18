export type RunStatus = 'running' | 'done' | 'failed' | 'dead'

export type Run = {
  dir: string
  kind: string
  label: string
  cwd: string
  isReviewer: boolean
  model: string
  status: RunStatus
  startedAt: number | null
  endedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-ui': {
      selectedRun: string | null
      expanded: string[]
      panelsOpen: string[]
      panelTabs: Record<string, string>
      panelFilters: Record<string, Record<string, string>>
    }
  }
}
