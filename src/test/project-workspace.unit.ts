import assert from 'node:assert/strict'
import test from 'node:test'
import { selectProjectWorkspace } from '../project-workspace'

interface Document {
  workspace?: string
  untitled?: boolean
}

interface WorkspaceFolder {
  name: string
  scheme: string
}

const localWorkspace = { name: 'local', scheme: 'file' }

test('falls back to an open local workspace and keeps an untitled source', () => {
  const untitledDocument: Document = { untitled: true }
  const selection = selectProjectWorkspace(
    untitledDocument,
    (document) =>
      document.workspace === localWorkspace.name ? localWorkspace : undefined,
    [localWorkspace],
    (folder) => folder.scheme === 'file',
    (document) => document.untitled === true,
  )

  assert.equal(selection.workspaceFolder, localWorkspace)
  assert.equal(selection.sourceDocument, untitledDocument)
})

test('does not use an unrelated scoped document as the source', () => {
  const unrelatedDocument: Document = {}
  const selection = selectProjectWorkspace(
    unrelatedDocument,
    () => undefined,
    [localWorkspace],
    (folder) => folder.scheme === 'file',
    (document) => document.untitled === true,
  )

  assert.equal(selection.workspaceFolder, localWorkspace)
  assert.equal(selection.sourceDocument, undefined)
})

test('uses the active document when it belongs to a local workspace', () => {
  const workspaceDocument: Document = { workspace: localWorkspace.name }
  const selection = selectProjectWorkspace(
    workspaceDocument,
    () => localWorkspace,
    [localWorkspace],
    (folder) => folder.scheme === 'file',
  )

  assert.equal(selection.workspaceFolder, localWorkspace)
  assert.equal(selection.sourceDocument, workspaceDocument)
})
