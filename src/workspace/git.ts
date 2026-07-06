import { invoke } from '@tauri-apps/api/core'

export interface GitFile {
  path: string
  status: string
  indexStatus: string
  worktreeStatus: string
  isUntracked: boolean
}

export interface GitStatus {
  repoRoot: string
  branch: string
  head: string
  files: GitFile[]
}

export const gitStatus = (cwd: string) => invoke<GitStatus>('git_status', { cwd })

export const gitDiff = (cwd: string, path: string) => invoke<string>('git_diff', { cwd, path })
