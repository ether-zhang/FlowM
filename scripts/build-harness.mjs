import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const release = process.argv.includes('--release')
const prepareOnly = process.argv.includes('--prepare-only')
const toolchain = process.env.FLOWM_BUILD_TOOLCHAIN || 'stable'
const run = (command, args, cwd, capture = false) => {
  const result = spawnSync(command, args, { cwd, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
  return result.stdout?.trim() ?? ''
}
const source = JSON.parse(await readFile(join(root, 'third_party', 'codex-source.json'), 'utf8'))
try { await stat(join(root, 'third_party', 'codex', '.git')) }
catch { throw new Error('Codex submodule is not initialized. Run git submodule update --init --recursive.') }
const vendorRoot = join(root, 'third_party', 'codex')
// Trust only this build's pinned submodule lookup. Sandbox-created checkouts can have a
// different Windows owner; this per-command setting does not change the user's Git config.
const upstreamHead = run('git', ['-c', `safe.directory=${vendorRoot.replaceAll('\\', '/')}`, '-C', vendorRoot, 'rev-parse', 'HEAD'], root, true)
if (upstreamHead !== source.revision) throw new Error(`Codex submodule must be pinned to ${source.revision}; found ${upstreamHead}.`)
const compiler = run('rustc', [`+${toolchain}`, '-vV'], root, true)
if (!compiler.includes('release: 1.96.0')) throw new Error('This runtime is pinned to Rust 1.96.0. Select that toolchain with FLOWM_BUILD_TOOLCHAIN.')
const target = compiler.match(/^host: (.+)$/m)?.[1]
if (!target) throw new Error('Rust target could not be resolved')
if (!prepareOnly) run('cargo', [`+${toolchain}`, 'build', '--locked', ...(release ? ['--release'] : [])], join(root, 'harness'))
const suffix = process.platform === 'win32' ? '.exe' : ''
const binary = join(root, 'harness', 'target', release ? 'release' : 'debug', `flowm-harness${suffix}`)
const destination = join(root, 'src-tauri', 'binaries')
await mkdir(destination, { recursive: true })
await copyFile(binary, join(destination, `flowm-harness-${target}${suffix}`))
const metadata = {
  protocolVersion: 'flowm.harness/8', harnessVersion: '0.1.0', upstreamRevision: source.revision,
  rustc: '1.96.0', target, buildProfile: release ? 'release' : 'debug',
  sha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
  cargoLockSha256: createHash('sha256').update(await readFile(join(root, 'harness', 'Cargo.lock'))).digest('hex'),
  bytes: (await stat(binary)).size,
  resources: ['flowm-harness', 'licenses/codex-LICENSE', 'licenses/codex-NOTICE'],
  windowsSandbox: 'unelevated restricted token; helper re-exec is embedded in flowm-harness',
}
await writeFile(join(destination, 'runtime-manifest.json'), JSON.stringify(metadata, null, 2))
console.log(`Prepared FlowM runtime for ${target} (${Math.round(metadata.bytes / 1024 / 1024)} MiB, ${metadata.buildProfile}).`)
