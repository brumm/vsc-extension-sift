#!/usr/bin/env node

import { applyEdits, modify, parse, printParseErrorCode } from 'jsonc-parser'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export const extensionId = 'local.sift'

export function argvPathSelection(
  platform = process.platform,
  environment = process.env,
  homeDirectory = homedir(),
) {
  if (platform !== 'darwin') {
    return {
      path: defaultArgvPath(platform, environment, homeDirectory),
      ignoredCandidates: [],
    }
  }

  const standardPath = posix.join(homeDirectory, '.vscode', 'argv.json')
  const legacyPath = posix.join(
    homeDirectory,
    'Library',
    'Application Support',
    'Code',
    'argv.json',
  )
  const portableRoot = environment.VSCODE_PORTABLE
  if (portableRoot) {
    return {
      path: posix.join(portableRoot, 'argv.json'),
      ignoredCandidates: [
        {
          path: standardPath,
          reason: 'VSCODE_PORTABLE is set',
        },
        {
          path: legacyPath,
          reason: 'current VS Code does not read runtime arguments here',
        },
      ],
    }
  }

  return {
    path: standardPath,
    ignoredCandidates: [
      {
        path: legacyPath,
        reason: 'current VS Code does not read runtime arguments here',
      },
    ],
  }
}

export function defaultArgvPath(
  platform = process.platform,
  environment = process.env,
  homeDirectory = homedir(),
) {
  switch (platform) {
    case 'darwin':
      return environment.VSCODE_PORTABLE
        ? posix.join(environment.VSCODE_PORTABLE, 'argv.json')
        : posix.join(homeDirectory, '.vscode', 'argv.json')
    case 'win32': {
      const appData = environment.APPDATA
      if (!appData || !win32.isAbsolute(appData)) {
        throw new Error(
          'APPDATA is not an absolute path; pass the argv.json path with --argv.',
        )
      }
      return win32.join(appData, 'Code', 'argv.json')
    }
    default: {
      const configuredPath = environment.XDG_CONFIG_HOME
      const configHome =
        configuredPath && posix.isAbsolute(configuredPath)
          ? configuredPath
          : posix.join(homeDirectory, '.config')
      return posix.join(configHome, 'Code', 'argv.json')
    }
  }
}

export function enableProposedApi(contents) {
  const errors = []
  const current = parse(contents, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const description = errors
      .map(
        (error) =>
          `${printParseErrorCode(error.error)} at offset ${error.offset}`,
      )
      .join(', ')
    throw new Error(`Cannot parse argv.json: ${description}`)
  }
  if (!current || Array.isArray(current) || typeof current !== 'object') {
    throw new Error(
      'Cannot update argv.json because its root value is not an object.',
    )
  }

  const existing = current['enable-proposed-api']
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(
      'Cannot update argv.json because "enable-proposed-api" is not an array.',
    )
  }
  if (existing?.includes(extensionId)) {
    return { changed: false, contents }
  }

  const eol = contents.includes('\r\n') ? '\r\n' : '\n'
  const edits = modify(
    contents,
    existing
      ? ['enable-proposed-api', existing.length]
      : ['enable-proposed-api'],
    existing ? extensionId : [extensionId],
    {
      formattingOptions: {
        insertSpaces: !contents.includes('\t'),
        tabSize: 2,
        eol,
      },
    },
  )
  return {
    changed: true,
    contents: applyEdits(contents, edits),
  }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function requestedArgvPath(arguments_) {
  const argvIndex = arguments_.indexOf('--argv')
  if (argvIndex === -1) {
    const selection = argvPathSelection()
    for (const candidate of selection.ignoredCandidates) {
      if (await pathExists(candidate.path)) {
        console.warn(
          `Ignoring ${candidate.path}: ${candidate.reason}; using ${selection.path}.`,
        )
      }
    }
    return selection.path
  }
  const value = arguments_[argvIndex + 1]
  if (!value) {
    throw new Error('--argv requires a path.')
  }
  return resolve(value)
}

async function main() {
  const argvPath = await requestedArgvPath(process.argv.slice(2))
  let contents = '{}\n'
  try {
    contents = await readFile(argvPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  const result = enableProposedApi(contents)
  if (result.changed) {
    let writablePath = argvPath
    try {
      if ((await lstat(argvPath)).isSymbolicLink()) {
        try {
          writablePath = await realpath(argvPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw error
          }
          writablePath = resolve(dirname(argvPath), await readlink(argvPath))
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }

    await mkdir(dirname(writablePath), { recursive: true })
    const temporaryPath = `${writablePath}.${process.pid}.${randomUUID()}.tmp`
    let mode
    try {
      mode = (await stat(writablePath)).mode & 0o777
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
    let temporaryCreated = false
    try {
      const temporaryFile = await open(temporaryPath, 'wx', mode)
      temporaryCreated = true
      try {
        await temporaryFile.writeFile(result.contents)
      } finally {
        await temporaryFile.close()
      }
      if (mode !== undefined) {
        await chmod(temporaryPath, mode)
      }
      await rename(temporaryPath, writablePath)
      temporaryCreated = false
    } finally {
      if (temporaryCreated) {
        await rm(temporaryPath, { force: true })
      }
    }
    console.log(`Enabled the proposed API for ${extensionId} in ${argvPath}`)
  } else {
    console.log(
      `The proposed API is already enabled for ${extensionId} in ${argvPath}`,
    )
  }
  console.log('Restart VS Code for the change to take effect.')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (
  invokedPath &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main()
}
