import assert from 'node:assert/strict'
import test from 'node:test'
import { selectProjectWorkspace } from '../project-workspace'

interface Document {
  workspace?: string
}

interface WorkspaceFolder {
  name: string
  scheme: string
}

const localWorkspace = { name: 'local', scheme: 'file' }

test('falls back to an open local workspace for an untitled editor', () => {
  const untitledDocument: Document = {}
  const selection = selectProjectWorkspace(
    untitledDocument,
    (document) =>
      document.workspace === localWorkspace.name ? localWorkspace : undefined,
    [localWorkspace],
    (folder) => folder.scheme === 'file',
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
