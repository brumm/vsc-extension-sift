import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import nodePath from 'node:path'
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')
const require = createRequire(import.meta.url)
const codiconIcons = nodePath.join(
  nodePath.dirname(require.resolve('@vscode/codicons/package.json')),
  'src/icons',
)
const codiconPlugin = {
  name: 'codicons',
  setup(build) {
    build.onResolve({ filter: /^sift-codicon:/ }, ({ path }) => ({
      path: nodePath.join(codiconIcons, `${path.slice('sift-codicon:'.length)}.svg`),
    }))
  },
}
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
  plugins: [codiconPlugin],
  loader: { '.html': 'text', '.svg': 'text' },
  logLevel: 'info',
}

if (!watch) {
  await esbuild.build(options)
} else {
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
