import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')
const entryPoints = [
  'src/extension.ts',
  ...readdirSync('src/test')
    .filter(file => file.endsWith('.ts'))
    .map(file => `src/test/${file}`),
]
const options = {
  entryPoints,
  outbase: 'src',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  outdir: 'out',
  sourcemap: true,
  packages: 'external',
  external: ['vscode'],
  loader: { '.html': 'text' },
  logLevel: 'info',
}

if (!watch) {
  await esbuild.build(options)
} else {
  const require = createRequire(import.meta.url)
  const typeScriptCli = require.resolve('typescript/bin/tsc')
  const typecheck = spawn(
    process.execPath,
    [typeScriptCli, '-p', './', '--noEmit', '--watch', '--preserveWatchOutput'],
    { stdio: 'inherit' },
  )
  const context = await esbuild.context(options)
  await context.watch()

  const dispose = async () => {
    typecheck.kill()
    await context.dispose()
  }
  process.once('SIGINT', () => void dispose().finally(() => process.exit(130)))
  process.once('SIGTERM', () => void dispose().finally(() => process.exit(143)))
}
