import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { EditMark, Entry, Listing, View } from '../types'

const roots = atom({ plugin: 'folder-map', key: 'roots' } as const, [])
const dirs = atom({ plugin: 'folder-map', key: 'dirs' } as const, {})
const edits = atom({ plugin: 'folder-map', key: 'edits' } as const, [])
const last = atom({ plugin: 'folder-map', key: 'last' } as const, '')
const view = atom({ plugin: 'folder-map', key: 'view' } as const, {
  mode: 'tree',
  autoOpen: true,
  quietFolder: '',
})

const PANE = 'folder-map'
const TITLE = 'Folder map'

// Shared with savvy-progress so the two panels read as one family.
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SKIP = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.nuxt',
  '.cache', 'target', '.turbo', '.pytest_cache', '.mypy_cache', 'coverage', '.gradle', 'Pods', '.idea',
])
const MARKERS = ['.git', '.claude-plugin', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
const MAX_DIRS = 300
const MAX_DEPTH = 10
const MAX_PER_DIR = 200
const MAX_ROWS = 600
const MAX_ROOTS = 4
const ROW_H = 22
const CHUNK = 80
const INDENT = 20

// ---------------------------------------------------------------------------
// Paths: always `/`-separated; compared case-blind on Windows drives.

const norm = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:$/.test(s) ? s + '/' : s || '/'
}
const keyOf = (p: string): string => (/^[A-Za-z]:/.test(p) ? p.toLowerCase() : p)
const join = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)
const isUnder = (p: string, root: string): boolean => {
  const a = keyOf(p)
  const b = keyOf(root)
  return a === b || a.startsWith(b.endsWith('/') ? b : b + '/')
}
const parentOf = (p: string): string => {
  const i = p.lastIndexOf('/')
  if (i < 0) return p
  return norm(p.slice(0, i) || '/')
}
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p
const absolute = (p: string, cwd: string): string => (/^[A-Za-z]:|^\//.test(p.replace(/\\/g, '/')) ? norm(p) : norm(join(cwd, p)))

/** Directory names from `root` (exclusive) down to `p` (inclusive). */
const segmentsBelow = (root: string, p: string): string[] =>
  keyOf(p) === keyOf(root) ? [] : p.slice(root.endsWith('/') ? root.length : root.length + 1).split('/').filter(Boolean)

/** Every directory from `root` down to `dir`, both included. */
const chainDirs = (root: string, dir: string): string[] => {
  const out = [root]
  let at = root
  for (const seg of segmentsBelow(root, dir)) {
    at = join(at, seg)
    out.push(at)
  }
  return out
}

// ---------------------------------------------------------------------------
// Scanning.

async function listDir($: EngineInterface, abs: string): Promise<Listing> {
  const raw = await $.fs.list(abs)
  const entries: Entry[] = raw
    .map((r): Entry => {
      const kind = r.kind === 'dir' ? 'dir' : r.kind === 'file' ? 'file' : 'other'
      return kind === 'dir' && SKIP.has(r.name) ? { name: r.name, kind, isSkipped: true } : { name: r.name, kind }
    })
    .sort(
      (a, b) =>
        (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  return { entries: entries.slice(0, MAX_PER_DIR), more: Math.max(0, entries.length - MAX_PER_DIR) }
}

// Breadth first, a level at a time, so a huge repo still shows its top.
async function scanTree($: EngineInterface, root: string): Promise<Record<string, Listing>> {
  const out: Record<string, Listing> = {}
  let level = [root]
  let count = 0
  for (let depth = 0; level.length && depth <= MAX_DEPTH && count < MAX_DIRS; depth++) {
    const batch = level.slice(0, MAX_DIRS - count)
    count += batch.length
    const lists = await Promise.all(batch.map(d => listDir($, d).catch(() => null)))
    const next: string[] = []
    batch.forEach((d, i) => {
      const l = lists[i]
      if (!l) return
      out[keyOf(d)] = l
      for (const en of l.entries) if (en.kind === 'dir' && !en.isSkipped) next.push(join(d, en.name))
    })
    level = next
  }
  return out
}

// The folder a file belongs to: a root already shown, the session's folder, or
// the nearest folder above it holding a project marker.
async function findRoot($: EngineInterface, file: string, cwd: string, shown: string[]): Promise<string> {
  const existing = shown.find(r => isUnder(file, r))
  if (existing) return existing
  if (cwd && isUnder(file, cwd)) return cwd
  let dir = parentOf(file)
  for (let i = 0; i < 6; i++) {
    const found = await Promise.all(MARKERS.map(m => $.fs.exists(join(dir, m)).catch(() => false)))
    if (found.some(Boolean)) return dir
    const up = parentOf(dir)
    if (up === dir) break
    dir = up
  }
  return parentOf(file)
}

async function rememberRoot($: EngineInterface, root: string, scanned: Record<string, Listing>): Promise<void> {
  const list = await update($, roots, prev => {
    // A wider root swallows the narrower ones beneath it.
    const kept = prev.filter(r => !isUnder(r, root))
    return [root, ...kept].slice(0, MAX_ROOTS)
  })
  await update($, dirs, prev => {
    const merged: Record<string, Listing> = {}
    for (const [k, v] of Object.entries({ ...prev, ...scanned })) if (list.some(r => isUnder(k, keyOf(r)))) merged[k] = v
    return merged
  })
}

async function track($: EngineInterface, file: string, tool: string, isNew: boolean): Promise<void> {
  const cwd = norm(await $.session.cwd())
  const root = await findRoot($, file, cwd, await read($, roots))
  const known = await read($, dirs)
  const scanned = known[keyOf(root)] ? {} : await scanTree($, root)
  // The file's own chain is listed again, so a new file or folder shows.
  const chain = chainDirs(root, parentOf(file))
  const lists = await Promise.all(chain.map(d => listDir($, d).catch(() => null)))
  chain.forEach((d, i) => {
    const l = lists[i]
    if (l) scanned[keyOf(d)] = l
  })
  await rememberRoot($, root, scanned)

  await update($, edits, list => {
    const at = list.findIndex(m => keyOf(m.path) === keyOf(file))
    if (at >= 0) return list.map((m, i) => (i === at ? { ...m, tool, count: m.count + 1 } : m))
    const seq = list.reduce((n, m) => Math.max(n, m.seq), 0) + 1
    return [...list, { path: file, tool, seq, count: 1, isNew }].slice(-200)
  })
  await update($, last, () => file)

  const v = await read($, view)
  if (!v.autoOpen) return
  if (v.quietFolder && keyOf(v.quietFolder) === keyOf(parentOf(file))) return
  if (v.quietFolder) await update($, view, prev => ({ ...prev, quietFolder: '' }))
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (!isOpen) await $.ui.open({ id: PANE, title: TITLE })
}

async function rescanAll($: EngineInterface): Promise<void> {
  const cwd = norm(await $.session.cwd())
  const list = await read($, roots)
  const targets = list.length ? list : [cwd]
  const scans = await Promise.all(targets.map(r => scanTree($, r)))
  const merged: Record<string, Listing> = Object.assign({}, ...scans)
  if (!list.length) await update($, roots, () => [cwd])
  await update($, dirs, () => merged)
}

async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  await update($, view, prev => ({ ...prev, quietFolder: '' }))
  if (!(await read($, roots)).length) await rescanAll($)
  await $.ui.open({ id: PANE, title: TITLE })
  return true
}

// ---------------------------------------------------------------------------
// Flattening a root into drawable rows.

type Row = {
  abs: string
  name: string
  depth: number
  kind: 'dir' | 'file' | 'other' | 'more'
  isOpen: boolean
  isSkipped: boolean
  isLastSibling: boolean
  /** Per column above this row: whether that ancestor's line continues. */
  guides: boolean[]
  /** Keys of this row's ancestors below the root, itself last. */
  ancestors: string[]
  mark?: EditMark
  /** Edited files beneath a folder. */
  touched: number
  more: number
}

type Tree = {
  root: string
  rows: Row[]
  trail: string[]
  index: Map<string, number>
  hidden: number
  isFocused: boolean
}

function flatten(root: string, listings: Record<string, Listing>, marks: EditMark[], lastFile: string, mode: View['mode']): Tree {
  const byKey = new Map(marks.map(m => [keyOf(m.path), m]))
  const touched = new Map<string, number>()
  for (const m of marks) {
    if (!isUnder(m.path, root)) continue
    for (const d of chainDirs(root, parentOf(m.path))) touched.set(keyOf(d), (touched.get(keyOf(d)) ?? 0) + 1)
  }
  const trail = lastFile && isUnder(lastFile, root) ? [...chainDirs(root, parentOf(lastFile)), lastFile].map(keyOf) : []

  const build = (focus: boolean): Row[] => {
    const rows: Row[] = []
    const walk = (dir: string, depth: number, guides: boolean[], ancestors: string[]) => {
      const l = listings[keyOf(dir)]
      if (!l) return
      l.entries.forEach((en, i) => {
        const isLastSibling = i === l.entries.length - 1 && !l.more
        const abs = join(dir, en.name)
        const k = keyOf(abs)
        const below = touched.get(k) ?? 0
        const isOpen = en.kind === 'dir' && !!listings[k] && (!focus || below > 0)
        const chain = [...ancestors, k]
        rows.push({
          abs,
          name: en.name,
          depth,
          kind: en.kind,
          isOpen,
          isSkipped: !!en.isSkipped,
          isLastSibling,
          guides,
          ancestors: chain,
          mark: en.kind === 'file' ? byKey.get(k) : undefined,
          touched: en.kind === 'dir' ? below : 0,
          more: 0,
        })
        if (isOpen) walk(abs, depth + 1, [...guides, !isLastSibling], chain)
      })
      if (l.more)
        rows.push({
          abs: join(dir, '…'),
          name: `${l.more} more`,
          depth,
          kind: 'more',
          isOpen: false,
          isSkipped: false,
          isLastSibling: true,
          guides,
          ancestors: [...ancestors, keyOf(join(dir, '…'))],
          touched: 0,
          more: l.more,
        })
    }
    walk(root, 0, [], [])
    return rows
  }

  let isFocused = mode === 'focus'
  let rows = build(isFocused)
  // A whole tree too big to read falls back to the edited branches.
  if (!isFocused && rows.length > MAX_ROWS) {
    isFocused = true
    rows = build(true)
  }
  const hidden = Math.max(0, rows.length - MAX_ROWS)
  rows = rows.slice(0, MAX_ROWS)
  const index = new Map(rows.map((r, i) => [keyOf(r.abs), i]))
  return { root, rows, trail, index, hidden, isFocused }
}

// How each guide column of a row is lit on the trail from the root to the
// latest file: column j belongs to the folder at depth j-1 (the root for 0).
function lit(t: Tree, r: Row, rowIdx: number, j: number): { up: boolean; down: boolean; across: boolean } {
  const none = { up: false, down: false, across: false }
  const owner = j === 0 ? keyOf(t.root) : r.ancestors[j - 1]
  if (!t.trail.length || t.trail[j] !== owner) return none
  const target = t.trail[j + 1]
  if (!target) return none
  const targetIdx = t.index.get(target)
  if (targetIdx === undefined) return none
  const self = r.ancestors[j]
  if (self === undefined) return none
  const selfIdx = j === r.depth ? rowIdx : t.index.get(self) ?? Infinity
  if (j < r.depth) return selfIdx < targetIdx ? { up: true, down: true, across: false } : none
  if (self === target) return { up: true, down: false, across: true }
  return selfIdx < targetIdx ? { up: true, down: true, across: false } : none
}

// ---------------------------------------------------------------------------
// Look: file colors by extension, the same SVG idiom as savvy-progress.

const EXT_COLOR: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', mts: '#3178c6', cts: '#3178c6',
  js: '#d4a514', jsx: '#d4a514', mjs: '#d4a514', cjs: '#d4a514',
  py: '#4b8bbe', ipynb: '#f37726', json: '#cb8a2c', md: '#7d7d79', mdx: '#7d7d79',
  css: '#a35bd6', scss: '#c6538c', html: '#e2582c', rs: '#ce7c4a', go: '#00a7d0',
  java: '#e76f00', kt: '#a97bff', sh: '#5fbf8f', ps1: '#5fbf8f', yml: '#c94a7a', yaml: '#c94a7a',
  toml: '#9c4221', sql: '#e38c00', csv: '#5fbf8f', txt: '#9a9a96', svg: '#e2a03f', png: '#b07cc6', jpg: '#b07cc6',
}
const extOf = (name: string): string => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '')
const colorOfFile = (name: string): string => EXT_COLOR[extOf(name)] ?? '#9a9a96'

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const charEm = (ch: string): number => (/[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Z@%mw]/.test(ch) ? 0.72 : 0.56)
const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.tile{fill:#f4f3f0}.fd{fill:#c9c6bd}.fdo{fill:#e2dfd6}
.g{stroke:#dddcd7}.bg{fill:#1f1f1f;opacity:0}.r:hover .bg{opacity:.05}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.tile{fill:#262625}.fd{fill:#6b6964}.fdo{fill:#55534f}.g{stroke:#3a3a38}.bg{fill:#ffffff}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd, as savvy-progress draws it (from DockCrab / Clawdy, via
// github.com/JohnnyVizz/claude-kit): a 24×18 crab on a 30×28 grid.
const CLAY = '#D97757'
const INK = '#1F1E1D'

type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

const crabBody = (f: Fill): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14, 4, 4, CLAY)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// `builder` wears the hard hat and turns a wrench: Claude made a new file.
const COSTUMES: Record<string, (f: Fill) => void> = {
  builder: f => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, ACCENT)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  plain: f => crabBody(f),
}

// Pure CSS, run by the compositor: legs step, the body bobs, a patrolling crab
// walks the row and turns at each end; a resting one breathes.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-builder.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.patrol{transform-box:fill-box;transform-origin:center;animation:patrol var(--t) linear infinite}
@keyframes patrol{0%{transform:translateX(0) scaleX(1)}49.9%{transform:translateX(var(--d)) scaleX(1)}50%{transform:translateX(var(--d)) scaleX(-1)}100%{transform:translateX(0) scaleX(-1)}}
.rest{transform-box:fill-box;transform-origin:50% 100%;animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{50%{transform:scaleY(.94)}}
@media (prefers-reduced-motion: reduce){.run,.run g,.patrol,.rest{animation:none!important}}
</style>`

const crab = (x: number, y: number, costume: string, isWalking: boolean, scale: number, dim = false): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  ;(COSTUMES[costume] ?? crabBody)(f)
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.5 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

// A crab that walks between two x positions, turning at each end.
const patrolCrab = (x0: number, x1: number, y: number, scale: number, costume: string): string => {
  const d = Math.max(0, Math.round(x1 - x0))
  if (d < 12) return crab(x0, y, costume, true, scale)
  return `<g class="patrol" style="--d:${d}px;--t:${Math.max(2, d / 22).toFixed(1)}s">${crab(x0, y, costume, true, scale)}</g>`
}

const costumeOf = (m: EditMark | undefined): string => (m?.isNew ? 'builder' : 'plain')

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${CRAB_CSS}${body}</svg>`

const folderIcon = (x: number, y: number, isOpen: boolean, fill: string | null): string => {
  const cls = fill ? '' : ' class="fd"'
  const f = fill ? ` fill="${fill}"` : ''
  const back = `<path${cls}${f} d="M${x} ${y + 2.5}a1.5 1.5 0 0 1 1.5-1.5h4l1.6 1.8h7.4a1.5 1.5 0 0 1 1.5 1.5v8.2a1.5 1.5 0 0 1-1.5 1.5h-13a1.5 1.5 0 0 1-1.5-1.5z"/>`
  if (!isOpen) return back
  const front = fill
    ? `<path fill="${fill}" opacity=".55" d="M${x + 1.2} ${y + 6}h14.6l-1.4 6.6a1.4 1.4 0 0 1-1.4 1.1h-12.4z"/>`
    : `<path class="fdo" d="M${x + 1.2} ${y + 6}h14.6l-1.4 6.6a1.4 1.4 0 0 1-1.4 1.1h-12.4z"/>`
  return back + front
}

const fileIcon = (x: number, y: number, color: string): string =>
  `<path d="M${x + 2.5} ${y}h6.5l4 4v9.5a1.5 1.5 0 0 1-1.5 1.5h-9a1.5 1.5 0 0 1-1.5-1.5v-12a1.5 1.5 0 0 1 1.5-1.5z" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.2"/><path d="M${x + 9} ${y}v4h4" fill="none" stroke="${color}" stroke-width="1.2"/>`

const badge = (cx: number, cy: number, n: number): string =>
  `<circle cx="${cx}" cy="${cy}" r="8" fill="${ACCENT}"/><text x="${cx}" y="${cy + 3.6}" text-anchor="middle" font-family="${FONT}" font-size="${n > 99 ? 7.5 : 10}" font-weight="700" fill="#fff" font-variant-numeric="tabular-nums">${n}</text>`

function rowSvg(t: Tree, r: Row, i: number, y: number, W: number, lastKey: string): string {
  const mid = y + ROW_H / 2
  const k = keyOf(r.abs)
  const isLast = k === lastKey
  const parts: string[] = []
  parts.push(`<rect class="bg" x="0" y="${y + 1}" width="${W}" height="${ROW_H - 2}" rx="6"/>`)
  if (isLast) {
    parts.push(`<rect x="0" y="${y + 1}" width="${W}" height="${ROW_H - 2}" rx="6" fill="${ACCENT}" fill-opacity=".14"/>`)
    parts.push(`<rect x="0" y="${y + 4}" width="3" height="${ROW_H - 8}" rx="1.5" fill="${ACCENT}"/>`)
  }
  // Guides: dim lines, the trail to the latest file in accent.
  for (let j = 0; j <= r.depth; j++) {
    const x = 12 + j * INDENT + 0.5
    const l = lit(t, r, i, j)
    const stroke = (on: boolean) => (on ? ` stroke="${ACCENT}" stroke-width="1.6"` : ' class="g" stroke-width="1"')
    if (j < r.depth) {
      if (r.guides[j]) parts.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + ROW_H}"${stroke(l.up)}/>`)
      continue
    }
    parts.push(`<path d="M${x} ${y}V${mid - 3}q0 3 3 3H${x + 8}" fill="none"${stroke(l.up)}/>`)
    if (!r.isLastSibling) parts.push(`<line x1="${x}" y1="${mid}" x2="${x}" y2="${y + ROW_H}"${stroke(l.down)}/>`)
  }
  const ix = 12 + r.depth * INDENT + 11
  const isOnTrail = t.trail.includes(k)
  if (r.kind === 'dir') parts.push(folderIcon(ix, mid - 7, r.isOpen, r.touched ? ACCENT : null))
  else if (r.kind === 'file' || r.kind === 'other') parts.push(fileIcon(ix + 1, mid - 7.5, colorOfFile(r.name)))

  // Right side: the edit's number, its count, a "new" tag; a folder's tally.
  const right: string[] = []
  let rx = W - 4
  if (r.mark) {
    right.push(badge(rx - 8, mid, r.mark.seq))
    rx -= 22
    if (r.mark.count > 1) {
      right.push(`<text class="s" x="${rx}" y="${mid + 4}" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">×${r.mark.count}</text>`)
      rx -= textWidth(`×${r.mark.count}`, 11) + 6
    }
    if (r.mark.isNew) {
      right.push(`<rect x="${rx - 28}" y="${mid - 7}" width="28" height="14" rx="7" fill="${DONE}"/><text x="${rx - 14}" y="${mid + 3.5}" text-anchor="middle" font-family="${FONT}" font-size="9" font-weight="700" fill="#fff">NEW</text>`)
      rx -= 34
    }
  } else if (r.kind === 'dir' && r.touched) {
    right.push(`<text x="${rx}" y="${mid + 4}" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="600" fill="${ACCENT}" font-variant-numeric="tabular-nums">${r.touched} edited</text>`)
    rx -= textWidth(`${r.touched} edited`, 11) + 8
  }

  const nx = ix + 22
  const maxW = Math.max(30, rx - nx - 6)
  if (r.kind === 'more') {
    parts.push(`<text class="m" x="${nx - 22}" y="${mid + 4}" font-family="${FONT}" font-size="12" font-style="italic">${xml(r.name)}</text>`)
  } else {
    const name = fitText(r.name + (r.isSkipped ? '  …' : ''), 12.5, maxW)
    const style = r.mark
      ? `fill="${ACCENT}" font-weight="600"`
      : r.isSkipped
        ? 'class="m"'
        : `class="t"${isOnTrail || r.touched ? ' font-weight="600"' : r.kind === 'dir' ? ' font-weight="500"' : ''}`
    parts.push(`<text ${style} x="${nx}" y="${mid + 4.3}" font-family="${FONT}" font-size="12.5">${xml(name)}</text>`)
    // The crab walks the free stretch of the current file's row.
    if (isLast) {
      const CRAB_W = 30 * 0.6
      const from = nx + textWidth(name, 12.5) + 10
      right.push(patrolCrab(from, Math.max(from, rx - CRAB_W - 4), mid - 8.6, 0.6, costumeOf(r.mark)))
    }
  }
  const tip = r.mark ? `${r.abs} — #${r.mark.seq}, ${r.mark.count} edit${r.mark.count > 1 ? 's' : ''}` : r.abs
  return `<g class="r"><title>${xml(tip)}</title>${parts.join('')}${right.join('')}</g>`
}

function rootRowSvg(t: Tree, W: number, touched: number): string {
  const mid = ROW_H / 2
  const label = fitText(baseName(t.root), 13.5, W - 120)
  const tally = touched
    ? `<text x="${W - 4}" y="${mid + 4}" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="600" fill="${ACCENT}">${touched} edited</text>`
    : ''
  return `<g class="r"><title>${xml(t.root)}</title>${folderIcon(4, mid - 7, true, touched ? ACCENT : null)}<text class="t" x="28" y="${mid + 4.5}" font-family="${FONT}" font-size="13.5" font-weight="700">${xml(label)}</text>${tally}</g>`
}

function treeSvgs(t: Tree, W: number, lastKey: string, touched: number): { source: string; height: number; alt: string }[] {
  const out: { source: string; height: number; alt: string }[] = []
  for (let start = 0; start === 0 || start < t.rows.length; start += CHUNK) {
    const slice = t.rows.slice(start, start + CHUNK)
    const head = start === 0 ? ROW_H : 0
    const body = slice.map((r, n) => rowSvg(t, r, start + n, head + n * ROW_H, W, lastKey)).join('')
    const height = head + slice.length * ROW_H + 2
    out.push({
      source: svg(W, height, (start === 0 ? rootRowSvg(t, W, touched) : '') + body),
      height,
      alt: `${baseName(t.root)}: rows ${start + 1}-${start + slice.length} of ${t.rows.length}`,
    })
    if (!slice.length) break
  }
  return out
}

type Stats = { files: number; folders: number; edits: number }

const statsOf = (marks: EditMark[]): Stats => ({
  files: marks.length,
  folders: new Set(marks.map(m => keyOf(parentOf(m.path)))).size,
  edits: marks.reduce((n, m) => n + m.count, 0),
})

// The header: three tiles, then the latest file's place as a breadcrumb.
function headerSvg(W: number, st: Stats, crumbs: string[], mark: EditMark | undefined): { source: string; height: number } {
  const gap = 6
  const tw = (W - gap * 2) / 3
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="16" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  let body = tile(0, 'Files edited', String(st.files)) + tile(1, 'Folders', String(st.folders)) + tile(2, 'Edits', String(st.edits))
  if (!mark || !crumbs.length) {
    // Nothing edited yet: the crab rests in an empty card.
    body += `<rect class="tile" x="0" y="48" width="${W}" height="40" rx="8"/>
<g class="rest">${crab(10, 54, 'plain', false, 1)}</g>
<text class="s" x="48" y="72" font-family="${FONT}" font-size="12">No edits yet. The map opens when Claude edits a file.</text>`
    return { source: svg(W, 92, body), height: 92 }
  }

  // Chips flow left to right and wrap; the file itself is the accent pill.
  const top = 48
  const pad = 10
  const lineH = 24
  const CRAB = 36
  const chips: string[] = []
  let x = pad
  let y = top + 34
  crumbs.forEach((c, i) => {
    const isFile = i === crumbs.length - 1
    const label = fitText(c, 12, W - pad * 2 - 40 - CRAB)
    const w = textWidth(label, 12) + (isFile ? 22 : 20)
    const sepW = i ? 14 : 0
    if (i && x + sepW + w > W - pad - CRAB) {
      x = pad
      y += lineH
    } else if (i) {
      chips.push(`<path d="M${x + 4} ${y - 9}l4 4-4 4" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`)
      x += sepW
    }
    if (isFile) {
      chips.push(`<rect x="${x}" y="${y - 14}" width="${w}" height="19" rx="9.5" fill="${ACCENT}"/><text x="${x + 11}" y="${y - 0.5}" font-family="${FONT}" font-size="12" font-weight="600" fill="#fff">${xml(label)}</text>`)
    } else {
      chips.push(`${folderIcon(x + 1, y - 12, false, null)}<text class="t" x="${x + 20}" y="${y - 0.5}" font-family="${FONT}" font-size="12">${xml(label)}</text>`)
    }
    x += w
  })
  const cardH = y - top + 12
  const meta = `#${mark.seq} · ${mark.tool}${mark.count > 1 ? ` · ${mark.count} edits` : ''} · depth ${crumbs.length - 1}`
  body += `<rect class="tile" x="0" y="${top}" width="${W}" height="${cardH}" rx="8"/>
<circle class="live" cx="${pad + 3}" cy="${top + 13}" r="3.5" fill="${ACCENT}"/>
<text class="s" x="${pad + 12}" y="${top + 17}" font-family="${FONT}" font-size="11">Last edit</text>
<text class="m" x="${W - pad - CRAB}" y="${top + 17}" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(meta)}</text>
${chips.join('')}
${crab(W - pad - 30, top + (cardH - 28) / 2, costumeOf(mark), true, 1)}`
  return { source: svg(W, top + cardH + 4, body), height: top + cardH + 4 }
}

// ---------------------------------------------------------------------------
// Terminal drawing: the same rows in text.

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const seqGlyph = (n: number): string => (n >= 1 && n <= 20 ? [...CIRCLED][n - 1] ?? `#${n}` : `#${n}`)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'folder-map',
      description: 'Show or hide the folder map: the project tree with every file Claude edited, in order',
    })
    return started
  })

  on('command.run', { command: 'folder-map' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Folder map opened.' : 'Folder map closed.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!EDIT_TOOLS.has(tool)) return next(e)
    const raw = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (typeof raw !== 'string' || !raw) return next(e)

    let file = norm(raw)
    let isNew = false
    try {
      file = absolute(raw, norm(await $.session.cwd()))
      isNew = tool === 'Write' && !(await $.fs.exists(file))
    } catch {
      // The map is a view: it never stands in the edit's way.
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    try {
      await track($, file, tool, isNew)
    } catch {
      // Same: a failed scan leaves the map as it was.
    }
    return ran
  })

  // The person closed it: stay quiet for edits in that folder.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      const file = await read($, last)
      if (file) await update($, view, prev => ({ ...prev, quietFolder: parentOf(file) }))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const rootList = await read($, roots)
    const listings = await read($, dirs)
    const marks = await read($, edits)
    const lastFile = await read($, last)
    const v: View = await read($, view)
    const lastKey = keyOf(lastFile)
    const st = statsOf(marks)
    const trees = rootList.map(r => flatten(r, listings, marks, lastFile, v.mode))
    const lastRoot = rootList.find(r => lastFile && isUnder(lastFile, r))
    const crumbs = lastRoot && lastFile ? [baseName(lastRoot), ...segmentsBelow(lastRoot, lastFile)] : []
    const lastMark = marks.find(m => keyOf(m.path) === lastKey)
    const touchedIn = (r: string) => marks.filter(m => isUnder(m.path, r)).length

    const controls = (
      <Box key="controls" flexDirection="row" gap={2}>
        <Button
          key="mode"
          plain
          label={v.mode === 'tree' ? '◎ Edited branches' : '▤ Full tree'}
          onPress={() => update($, view, (prev): View => ({ ...prev, mode: prev.mode === 'tree' ? 'focus' : 'tree' }))}
        />
        <Button
          key="auto"
          plain
          label={v.autoOpen ? '● Auto-open' : '○ Auto-open'}
          onPress={() => update($, view, prev => ({ ...prev, autoOpen: !prev.autoOpen }))}
        />
        <Button key="refresh" plain label="↻ Refresh" onPress={() => rescanAll($)} />
      </Box>
    )
    const empty = !rootList.length && (
      <Text key="empty" dimColor>
        No edits yet. The map opens on its own when Claude edits a file.
      </Text>
    )
    const notes = (t: Tree) =>
      [
        t.isFocused && v.mode === 'tree' ? 'Large folder: showing the edited branches.' : '',
        t.hidden ? `${t.hidden} more rows not shown.` : '',
      ].filter(Boolean)

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const head = headerSvg(W, st, crumbs, lastMark)
      return (
        <Box flexDirection="column" gap={1}>
          <Svg
            key="header"
            source={head.source}
            alt={`${st.files} files edited in ${st.folders} folders${crumbs.length ? `; last: ${crumbs.join(' / ')}` : ''}`}
            width={W}
            height={head.height}
          />
          {controls}
          {trees.map(t => (
            <Box key={`root-${keyOf(t.root)}`} flexDirection="column">
              {treeSvgs(t, W, lastKey, touchedIn(t.root)).map((c, n) => (
                <Svg key={`tree-${keyOf(t.root)}-${n}`} source={c.source} alt={c.alt} width={W} height={c.height} isInteractive />
              ))}
              {notes(t).map(s => (
                <Text key={s} dimColor>
                  {s}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )
    }

    // Terminal and the other surfaces: text rows with box-drawing guides.
    const line = (t: Tree, r: Row, i: number) => {
      const k = keyOf(r.abs)
      const isLast = k === lastKey
      const cols: { text: string; on: boolean }[] = []
      for (let j = 0; j <= r.depth; j++) {
        const l = lit(t, r, i, j)
        if (j < r.depth) cols.push({ text: r.guides[j] ? '│  ' : '   ', on: l.up && !!r.guides[j] })
        else cols.push({ text: r.isLastSibling ? '└─ ' : '├─ ', on: l.across || l.up })
      }
      const icon = r.kind === 'dir' ? (r.isOpen ? '▾ ' : '▸ ') : r.kind === 'more' ? '' : '• '
      const iconColor = r.kind === 'dir' ? (r.touched ? ACCENT : undefined) : colorOfFile(r.name)
      return (
        <Text key={`${keyOf(t.root)}:${i}`} wrap="truncate-end">
          {cols.map((c, n) =>
            c.on ? (
              <Text key={`g${n}`} color={ACCENT}>
                {c.text}
              </Text>
            ) : (
              <Text key={`g${n}`} dimColor>
                {c.text}
              </Text>
            ),
          )}
          {icon && <Text color={iconColor}>{icon}</Text>}
          {r.mark ? (
            <Text color={ACCENT} bold>
              {r.name}
            </Text>
          ) : r.kind === 'more' || r.isSkipped ? (
            <Text dimColor>{r.isSkipped ? `${r.name} …` : r.name}</Text>
          ) : (
            <Text bold={t.trail.includes(k) || r.touched > 0}>{r.name}</Text>
          )}
          {r.mark && (
            <Text color={ACCENT}>
              {' '}
              {seqGlyph(r.mark.seq)}
              {r.mark.count > 1 ? ` ×${r.mark.count}` : ''}
            </Text>
          )}
          {r.mark?.isNew && <Text color={DONE}> new</Text>}
          {r.kind === 'dir' && r.touched > 0 && <Text color={ACCENT}> ({r.touched})</Text>}
          {isLast && <Text color={CLAY}> ▣</Text>}
          {isLast && <Text color={ACCENT}> ◀ now</Text>}
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        {crumbs.length > 0 && (
          <Text wrap="truncate-start">
            <Text color={CLAY}>▣ </Text>
            {crumbs.slice(0, -1).map((c, n) => (
              <Text key={`c${n}`} dimColor>
                {c} ›{' '}
              </Text>
            ))}
            <Text color={ACCENT} bold>
              {crumbs[crumbs.length - 1]}
            </Text>
          </Text>
        )}
        <Text dimColor>
          {st.files} files · {st.folders} folders · {st.edits} edits
          {lastMark ? ` · last ${seqGlyph(lastMark.seq)} ${lastMark.tool}` : ''}
        </Text>
        {controls}
        {empty}
        {trees.map(t => (
          <Box key={`root-${keyOf(t.root)}`} flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text color={touchedIn(t.root) ? ACCENT : undefined}>▾ </Text>
              <Text bold>{baseName(t.root)}</Text>
              <Text dimColor> {t.root}</Text>
            </Text>
            {t.rows.map((r, i) => line(t, r, i))}
            {notes(t).map(s => (
              <Text key={s} dimColor>
                {s}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
