export interface UserInfo {
  email: string | null
  clientId: string | null
  teamId: string | null
  mode: 'p2p' | 'server' | 'local'
  remote: string | null
  baseDirectory: string
  sync: Record<string, unknown>
  presence: { enabled: boolean }
  p2p: Record<string, unknown>
}

export interface DiffSummary {
  conflicts: number
  missingLocally: number
  missingRemotely: number
  mergeable?: number
}

export interface Revision {
  hash: string
  email?: string
  updated?: string
}

export interface DiffDoc {
  id: string
  file: string
  revisions: Record<string, Revision>
}

export interface DiffItem {
  id: string
  diffType: 'conflict' | string
  missingLocally: boolean
  missingRemotely: boolean
  doc: DiffDoc
}

export interface DiffResponse {
  total: number
  page: number
  limit: number
  pages: number
  summary: DiffSummary
  items: DiffItem[]
}

export interface PresenceNode {
  email: string
  nodeType: string
  hostname: string
  activeFiles: string[]
  lastSeen: string
  status: 'active' | 'idle' | 'offline'
}

export interface OverlapWarning {
  fileId: string
  severity: number
  nodes: { email: string }[]
}

export interface SyncStatus {
  state: string
  lastSync: string | null
  error?: string
}

export interface SearchResult {
  file_path: string
  start_line: number
  end_line: number
  language: string | null
  node_type?: string
  node_name?: string
  signature?: string
  content?: string
  score: number | null
}

export interface SearchResponse {
  query: string
  type: string
  count: number
  results: SearchResult[]
}
