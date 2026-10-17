export type EntryKind = 'file' | 'dir' | 'other'

export type Entry = {
  name: string
  kind: EntryKind
  /** A heavy folder (node_modules, .git, ...): listed, never descended. */
  isSkipped?: boolean
}

/** One directory's listing, dirs first; `more` counts entries past the cap. */
export type Listing = {
  entries: Entry[]
  more: number
}

export type EditMark = {
  /** Absolute path, `/`-separated. */
  path: string
  tool: string
  /** Order of first edit in the session, from 1. */
  seq: number
  count: number
  isNew: boolean
}

export type View = {
  mode: 'tree' | 'focus'
  autoOpen: boolean
  /** The folder whose edits stay quiet after the person closed the pane. */
  quietFolder: string
}

declare module 'claude-code' {
  interface PluginState {
    'folder-map': {
      /** Project roots shown, the one holding the latest edit first. */
      roots: string[]
      /** Listings keyed by directory path (lower-cased on Windows). */
      dirs: Record<string, Listing>
      edits: EditMark[]
      last: string
      view: View
    }
  }
}
