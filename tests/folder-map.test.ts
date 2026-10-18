import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// A small fake project the plugin's `$.fs` calls are answered from.
const ROOT = 'C:/proj'
const FS: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
  'C:/proj': [
    { name: 'src', kind: 'dir' },
    { name: 'node_modules', kind: 'dir' },
    { name: 'package.json', kind: 'file' },
    { name: 'README.md', kind: 'file' },
  ],
  'C:/proj/src': [
    { name: 'components', kind: 'dir' },
    { name: 'index.ts', kind: 'file' },
  ],
  'C:/proj/src/components': [{ name: 'Button.tsx', kind: 'file' }],
}

// The engine hands `fs.*` hooks native separators (`C:\proj`).
const slash = (p: string): string => p.replace(/\\/g, '/')
const list = (p: string) => (FS[slash(p)] ?? []).map(en => ({ ...en, size: 0, mtimeMs: 0, isLink: false }))

// A crab element in the drawn SVG (the class names also sit in its CSS).
const PATROL = /class=\\*"patrol/
const REST = /class=\\*"rest/

const PANE_PROPS = {
  title: 'Folder map',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('an edit opens the map with the tree and a numbered, highlighted file', async ($, on) => {
  const opened: string[] = []
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: true }[] = []
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.list', ($, e) => ({ value: list(e.path) }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) in FS || e.path.endsWith('.tsx') }))
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true as const }]
    return { value: { isPlaced: true as const } }
  })
  on('tool.call', () => ({ result: { ok: true } }))

  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\components\\Button.tsx', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/proj/src/index.ts', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/src/index.ts', old_string: 'x', new_string: 'y' })

  expect(opened).toEqual(['folder-map'])

  // Terminal: text rows; the latest file is marked and numbered second.
  const term = await $.ui.mount({ plugin: 'folder-map', surface: 'terminal', component: 'Pane', requestId: 'folder-map', props: PANE_PROPS })
  expect(await term.find({ type: 'Text', text: /Button\.tsx/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /node_modules …/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /◀ now/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /② ×2/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /2 files · 2 folders · 3 edits/ })).toBeDefined()

  // Focus mode keeps the edited branches and drops nothing on them.
  await term.press({ key: 'mode' })
  expect(await term.find({ type: 'Text', text: /Button\.tsx/ })).toBeDefined()
  await term.unmount()

  // Desktop: SVG header plus the tree drawing.
  const desk = await $.ui.mount({ plugin: 'folder-map', surface: 'desktop', component: 'Pane', requestId: 'folder-map', props: PANE_PROPS })
  const svgs = await desk.findAll({ type: 'Svg' })
  expect(svgs.length).toBeGreaterThan(1)
  expect(await desk.find({ key: 'auto' })).toBeDefined()
  // index.ts was created by Write: the hard-hat crab walks in the card and patrols its row.
  const drawn = JSON.stringify(await desk.drawn())
  expect(drawn).toContain('c-builder run')
  expect(PATROL.test(drawn)).toBe(true)
  await desk.unmount()
})

// A host with one pane slot: opens, closes and lists it as a session would.
function paneHost(on: On, fs: typeof FS) {
  const opened: string[] = []
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: true }[] = []
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.list', ($, e) => ({ value: (fs[slash(e.path)] ?? []).map(en => ({ ...en, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) in fs }))
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true as const }]
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    panes = panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: { ok: true } }))
  return { opened, isOpen: () => panes.some(p => p.id === 'folder-map') }
}

const edit = (file_path: string) => ({ tool: 'Edit' as const, file_path, old_string: 'a', new_string: 'b' })

test('closing the map with /folder-map keeps that folder quiet until an edit elsewhere', async ($, on) => {
  const host = paneHost(on, FS)
  await $.tool.call(edit('C:/proj/src/index.ts'))
  expect(host.isOpen()).toBe(true)

  await $.command.run({ command: 'folder-map', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(host.isOpen()).toBe(false)

  // Same folder: stays closed.
  await $.tool.call(edit('C:/proj/src/index.ts'))
  expect(host.isOpen()).toBe(false)

  // Another folder: opens again.
  await $.tool.call(edit('C:/proj/src/components/Button.tsx'))
  expect(host.isOpen()).toBe(true)
})

test('edited branches leaves out folders with no edits beneath them', async ($, on) => {
  paneHost(on, FS)
  await $.tool.call(edit('C:/proj/src/index.ts'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'folder-map', surface, component: 'Pane', requestId: 'folder-map', props: PANE_PROPS })
    const full = JSON.stringify(await pane.drawn())
    expect(full).toContain('components')
    expect(full).toContain('node_modules')

    await pane.press({ key: 'mode' })
    const focused = JSON.stringify(await pane.drawn())
    expect(focused).toContain('index.ts')
    expect(focused).toContain('src')
    expect(focused).not.toContain('components')
    expect(focused).not.toContain('node_modules')

    await pane.press({ key: 'mode' })
    await pane.unmount()
  }
})

test('an edited file past the listing cap keeps its numbered row', async ($, on) => {
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.ts`, kind: 'file' as const }))
  const fs = { 'C:/proj': [{ name: 'big', kind: 'dir' as const }], 'C:/proj/big': [...many, { name: 'z-last.ts', kind: 'file' as const }] }
  paneHost(on, fs)
  await $.tool.call(edit('C:/proj/big/z-last.ts'))

  const term = await $.ui.mount({ plugin: 'folder-map', surface: 'terminal', component: 'Pane', requestId: 'folder-map', props: PANE_PROPS })
  expect(await term.find({ type: 'Text', text: /z-last\.ts ①/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /◀ now/ })).toBeDefined()
  // 251 entries, 200 listed, z-last.ts put back: 50 more.
  expect(await term.find({ type: 'Text', text: /50 more/ })).toBeDefined()
  await term.unmount()
})

test('failed edits are not tracked and do not open the map', async ($, on) => {
  const opened: string[] = []
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.list', ($, e) => ({ value: list(e.path) }))
  on('fs.exists', () => ({ value: true }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('tool.call', () => ({ isError: true as const, result: 'boom', text: 'boom' }))

  await $.tool.call({ tool: 'Edit', file_path: 'C:/proj/src/index.ts', old_string: 'x', new_string: 'y' })
  expect(opened).toEqual([])

  // Nothing tracked: a resting crab and the empty-state line.
  const desk = await $.ui.mount({ plugin: 'folder-map', surface: 'desktop', component: 'Pane', requestId: 'folder-map', props: PANE_PROPS })
  const drawn = JSON.stringify(await desk.drawn())
  expect(REST.test(drawn)).toBe(true)
  expect(drawn).toContain('No edits yet')
  expect(PATROL.test(drawn)).toBe(false)
  await desk.unmount()
})
