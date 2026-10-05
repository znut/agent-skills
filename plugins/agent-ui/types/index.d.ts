export type RunKind = 'gpt' | 'kimi' | 'claude' | 'claude-panel' | '?'
export type RunStatus = 'running' | 'done' | 'failed' | 'dead'

export type Run = {
  dir: string
  kind: RunKind
  label: string
  cwd: string
  isReviewer: boolean
  model: string
  status: RunStatus
  startedAt: number | null
  endedAt: number | null
}

export type OpenAsk = { n: number; text: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-ui': {
      selectedRun: string | null
      openAsk: OpenAsk | null
      expanded: string[]
      ciOpen: boolean
      ciMetric: 'wall' | 'cpu' | 'mem'
      panelsOpen: string[]
      panelTabs: Record<string, string>
    }
  }
}
