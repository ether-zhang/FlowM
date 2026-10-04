// Read-only public model discovery through FlowM's native runtime. Does not submit inference.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

const baseUrl = process.argv[2]
if (!baseUrl) throw new Error('Usage: npm run harness:check-gateway -- https://your-gateway/api/v1')
const root = resolve(import.meta.dirname, '..')
const binary = process.env.FLOWM_TEST_HARNESS ?? join(root, 'harness', 'target', 'debug', process.platform === 'win32' ? 'flowm-harness.exe' : 'flowm-harness')
await stat(binary)
await mkdir(join(root, 'tmp'), { recursive: true })
const directory = await mkdtemp(join(root, 'tmp', 'gateway-check-'))
const child = spawn(binary, ['--home', join(directory, 'private')], { cwd: root, windowsHide: true })
const exited = once(child, 'exit')
const pending = new Map()
let sequence = 0
let diagnostics = ''
child.stderr.on('data', (data) => { diagnostics = (diagnostics + data).slice(-4000) })
createInterface({ input: child.stdout }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { child.kill(); return }
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timer)
  if (message.error) request.reject(new Error(message.error.message))
  else request.resolve(message.result)
})
child.on('exit', (code) => {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Harness exited ${code}`)) }
  pending.clear()
})
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Gateway check timed out: ${method}`)) }, 60_000)
  pending.set(id, { resolve, reject, timer })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
let evidence = { baseUrl, inferenceRequests: 0, passed: false }
try {
  const manifest = JSON.parse(await readFile(join(root, 'src-tauri', 'binaries', 'runtime-manifest.json'), 'utf8'))
  const initialized = await rpc('initialize', { protocolVersion: manifest.protocolVersion })
  const profileId = randomUUID()
  await rpc('profiles/save', { profile: { id: profileId, name: 'Public gateway discovery check', kind: 'gateway',
    baseUrl, model: '', authKind: 'none', credentialVersion: 0, account: null, subject: null, clientId: null } })
  const catalog = await rpc('models/list', { profileId })
  assert.equal(catalog.source, 'gateway')
  assert.ok(catalog.models.length > 0)
  assert.ok(catalog.models.every((model) => model.origin === 'remote'))
  assert.equal(new Set(catalog.models.map((model) => model.id)).size, catalog.models.length)
  evidence = { ...evidence, passed: true, models: catalog.models.length, upstreamRevision: initialized.upstreamRevision,
    sample: catalog.models.slice(0, 6) }
  console.log(JSON.stringify(evidence, null, 2))
} catch (error) {
  evidence.error = error.message
  throw error
} finally {
  await writeFile(join(directory, 'evidence.json'), JSON.stringify({ ...evidence, diagnostics }, null, 2))
  console.log(`Gateway discovery evidence: ${directory}`)
  child.stdin.end()
  const timer = setTimeout(() => child.kill(), 10_000)
  await exited
  clearTimeout(timer)
}
