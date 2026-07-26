import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
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
  argvPathSelection,
  defaultArgvPath,
  enableProposedApi,
  extensionId,
  installExtensionSymlink,
} from './enable-proposed-api.mjs'

test('derives the extension ID from the package manifest', () => {
  assert.equal(extensionId, 'brumm.sift')
})

test('installs the local extension symlink idempotently', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'sift-link-home-'))
  try {
    const first = await installExtensionSymlink(homeDirectory)
    const second = await installExtensionSymlink(homeDirectory)

    assert.equal(first.changed, true)
    assert.equal(second.changed, false)
    assert.equal((await lstat(first.linkPath)).isSymbolicLink(), true)
    assert.equal(
      await readlink(first.linkPath),
      dirname(dirname(fileURLToPath(import.meta.url))),
    )
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('refuses to overwrite a non-symlink extension install', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'sift-link-home-'))
  const linkPath = join(
    homeDirectory,
    '.vscode',
    'extensions',
    'brumm.sift-0.0.1',
  )
  try {
    await mkdir(linkPath, { recursive: true })
    await assert.rejects(
      installExtensionSymlink(homeDirectory),
      /exists and is not a symbolic link/,
    )
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

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
  assert.match(result.contents, /brumm\.sift/)
})

test('replaces the previous local extension ID', () => {
  const result = enableProposedApi(`{
  "enable-proposed-api": ["another.extension", "local.sift"]
}
`)

  assert.equal(result.changed, true)
  assert.match(result.contents, /another\.extension/)
  assert.match(result.contents, /brumm\.sift/)
  assert.doesNotMatch(result.contents, /local\.sift/)
})

test('resolves the current Stable argv.json location by platform', () => {
  assert.equal(
    defaultArgvPath('darwin', {}, '/Users/test'),
    '/Users/test/.vscode/argv.json',
  )
  assert.equal(
    defaultArgvPath(
      'darwin',
      { VSCODE_PORTABLE: '/Volumes/PortableCode' },
      '/Users/test',
    ),
    '/Volumes/PortableCode/argv.json',
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

test('macOS selection prefers the location read by VS Code', () => {
  assert.deepEqual(
    argvPathSelection('darwin', {}, '/Users/test'),
    {
      path: '/Users/test/.vscode/argv.json',
      ignoredCandidates: [
        {
          path: '/Users/test/Library/Application Support/Code/argv.json',
          reason: 'current VS Code does not read runtime arguments here',
        },
      ],
    },
  )
  assert.deepEqual(
    argvPathSelection(
      'darwin',
      { VSCODE_PORTABLE: '/Volumes/PortableCode' },
      '/Users/test',
    ),
    {
      path: '/Volumes/PortableCode/argv.json',
      ignoredCandidates: [
        {
          path: '/Users/test/.vscode/argv.json',
          reason: 'VSCODE_PORTABLE is set',
        },
        {
          path: '/Users/test/Library/Application Support/Code/argv.json',
          reason: 'current VS Code does not read runtime arguments here',
        },
      ],
    },
  )
})

test('rejects a null root with a useful error', () => {
  assert.throws(
    () => enableProposedApi('null\n'),
    /root value is not an object/,
  )
})

test('CLI uses ~/.vscode when the legacy macOS file also exists', {
  skip: process.platform !== 'darwin',
}, async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'sift-argv-home-'))
  const standardPath = join(homeDirectory, '.vscode', 'argv.json')
  const legacyPath = join(
    homeDirectory,
    'Library',
    'Application Support',
    'Code',
    'argv.json',
  )
  try {
    await mkdir(dirname(standardPath), { recursive: true })
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(standardPath, '{}\n')
    await writeFile(legacyPath, '{}\n')

    const script = fileURLToPath(new URL('./enable-proposed-api.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDirectory,
        VSCODE_PORTABLE: '',
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(await readFile(standardPath, 'utf8'), /brumm\.sift/)
    assert.doesNotMatch(await readFile(legacyPath, 'utf8'), /brumm\.sift/)
    assert.match(result.stderr, /Ignoring .*Application Support.*using .*\.vscode/)
    const extensionLink = join(
      homeDirectory,
      '.vscode',
      'extensions',
      'brumm.sift-0.0.1',
    )
    assert.equal((await lstat(extensionLink)).isSymbolicLink(), true)
    assert.equal(
      await readlink(extensionLink),
      dirname(dirname(fileURLToPath(import.meta.url))),
    )
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
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
      env: {
        ...process.env,
        HOME: directory,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal((await lstat(argvLink)).isSymbolicLink(), true)
    assert.match(await readFile(argvTarget, 'utf8'), /brumm\.sift/)
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
      env: {
        ...process.env,
        HOME: directory,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal((await lstat(argvLink)).isSymbolicLink(), true)
    assert.match(await readFile(argvTarget, 'utf8'), /brumm\.sift/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
