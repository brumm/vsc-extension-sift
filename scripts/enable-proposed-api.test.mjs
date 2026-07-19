import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  defaultArgvPath,
  enableProposedApi,
  extensionId,
} from './enable-proposed-api.mjs'

test('adds the extension without discarding comments or existing arguments', () => {
  const input = `{
  // Keep this setting.
  "enable-crash-reporter": false,
}
`
  const result = enableProposedApi(input)

  assert.equal(result.changed, true)
  assert.match(result.contents, /\/\/ Keep this setting\./)
  assert.deepEqual(
    enableProposedApi(result.contents),
    { changed: false, contents: result.contents },
  )
  assert.match(result.contents, new RegExp(extensionId.replaceAll('.', '\\.')))
})

test('appends to an existing proposed API list without discarding comments', () => {
  const result = enableProposedApi(`{
  "enable-proposed-api": [
    // Keep this extension enabled too.
    "another.extension"
  ]
}
`)

  assert.equal(result.changed, true)
  assert.match(result.contents, /\/\/ Keep this extension enabled too\./)
  assert.match(result.contents, /another\.extension/)
  assert.match(result.contents, /local\.editor-filter/)
})

test('resolves the current Stable argv.json location by platform', () => {
  assert.equal(
    defaultArgvPath('darwin', {}, '/Users/test'),
    '/Users/test/Library/Application Support/Code/argv.json',
  )
  assert.equal(
    defaultArgvPath('linux', {}, '/home/test'),
    '/home/test/.config/Code/argv.json',
  )
  assert.equal(
    defaultArgvPath('linux', { XDG_CONFIG_HOME: '' }, '/home/test'),
    '/home/test/.config/Code/argv.json',
  )
  assert.equal(
    defaultArgvPath('linux', { XDG_CONFIG_HOME: 'relative' }, '/home/test'),
    '/home/test/.config/Code/argv.json',
  )
  assert.equal(
    defaultArgvPath('win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'unused'),
    'C:\\Users\\test\\AppData\\Roaming\\Code\\argv.json',
  )
  assert.throws(
    () => defaultArgvPath('win32', { APPDATA: 'relative' }, 'unused'),
    /APPDATA is not an absolute path/,
  )
  assert.throws(
    () => defaultArgvPath('win32', { APPDATA: '' }, 'unused'),
    /APPDATA is not an absolute path/,
  )
})

test('rejects a null root with a useful error', () => {
  assert.throws(
    () => enableProposedApi('null\n'),
    /root value is not an object/,
  )
})

test('CLI invocation and argv.json both work through symlinks', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-enable-proposed-api-'))
  try {
    const scriptTarget = fileURLToPath(new URL('./enable-proposed-api.mjs', import.meta.url))
    const scriptLink = join(directory, 'enable-proposed-api.mjs')
    const argvTarget = join(directory, 'dotfiles', 'argv.json')
    const argvLink = join(directory, 'argv.json')
    await mkdir(dirname(argvTarget), { recursive: true })
    await writeFile(argvTarget, '{}\n')
    await chmod(argvTarget, 0o664)
    await symlink(scriptTarget, scriptLink)
    await symlink(argvTarget, argvLink)

    const result = spawnSync(process.execPath, [scriptLink, '--argv', argvLink], {
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal((await lstat(argvLink)).isSymbolicLink(), true)
    assert.match(await readFile(argvTarget, 'utf8'), /local\.editor-filter/)
    assert.equal((await stat(argvTarget)).mode & 0o777, 0o664)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI preserves a dangling argv.json symlink and creates its target', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sift-enable-proposed-api-'))
  try {
    const argvLink = join(directory, 'argv.json')
    const relativeTarget = join('dotfiles', 'argv.json')
    const argvTarget = join(directory, relativeTarget)
    await symlink(relativeTarget, argvLink)

    const script = fileURLToPath(new URL('./enable-proposed-api.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, '--argv', argvLink], {
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal((await lstat(argvLink)).isSymbolicLink(), true)
    assert.match(await readFile(argvTarget, 'utf8'), /local\.editor-filter/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
