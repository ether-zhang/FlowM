// Offline integration against the real, embedded kernel. Never uses a paid model or installed CLI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, stat, access } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

const root = resolve(import.meta.dirname, '..')
const binary = process.env.FLOWM_TEST_HARNESS ?? join(root, 'harness', 'target', 'debug', process.platform === 'win32' ? 'flowm-harness.exe' : 'flowm-harness')
await stat(binary)
await mkdir(join(root, 'tmp'), { recursive: true })
const testRoot = await mkdtemp(join(root, 'tmp', 'harness-integration-'))
const home = join(testRoot, 'private')
const project = join(testRoot, 'project')
const foreignHome = join(testRoot, 'external-codex')
await mkdir(project)
await mkdir(foreignHome)
await writeFile(join(project, 'sample.txt'), 'original')
await writeFile(join(foreignHome, 'config.toml'), 'INVALID EXTERNAL CONFIG: MUST NEVER BE READ')

const responses = []
const requests = []
const authorizations = []
const discoveredModel = process.env.FLOWM_TEST_MODEL || 'gpt-5.5'
let availableModels = [discoveredModel]
let catalogRequests = 0
let heldRequests = 0
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    catalogRequests++
    assert.equal(request.headers['cache-control'], 'no-cache, no-store')
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: availableModels.map((id) => ({ id })) }))
    return
  }
  let content = ''
  for await (const chunk of request) content += chunk
  if (request.method !== 'POST' || request.url !== '/v1/responses') {
    response.writeHead(404).end('unexpected route')
    return
  }
  requests.push(JSON.parse(content))
  authorizations.push(request.headers.authorization ?? null)
  const next = responses.shift()
  if (!next) { response.writeHead(500).end('No response fixture'); return }
  if (next.status) { response.writeHead(next.status).end(JSON.stringify({ error: { message: 'simulated provider failure' } })); return }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  if (next.hold) { heldRequests++; response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: randomUUID() } })}\n\n`); return }
  const events = [
    { type: 'response.created', response: { id: randomUUID() } },
    next,
    { type: 'response.completed', response: { id: randomUUID(), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
  ]
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')

const child = spawn(binary, ['--home', home], { cwd: project, windowsHide: true, env: { ...process.env, CODEX_HOME: foreignHome } })
const pending = new Map()
const events = []
let questionListener = null
let diagnostics = ''
let rpcId = 0
child.stderr.on('data', (data) => { diagnostics = (diagnostics + data).slice(-20000) })
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id != null) {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timeout)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  } else {
    events.push(message)
    if (message.params?.event?.kind === 'question') questionListener?.(message.params)
  }
})
child.on('exit', (code) => {
  for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error(`Harness exited ${code}\n${diagnostics}`)) }
  pending.clear()
})
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++rpcId
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}\n${diagnostics}`)) }, 60000)
  pending.set(id, { resolve, reject, timeout })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const message = (text) => ({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: randomUUID(), content: [{ type: 'output_text', text }] } })
const tool = (name, args) => ({ type: 'response.output_item.done', item: { type: 'function_call', call_id: randomUUID(), name, arguments: JSON.stringify(args) } })
const envelope = JSON.stringify({ reply: 'checked', question: null, operations: [] })

try {
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/2' }), /protocol/i)
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/3' }), /protocol/i)
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/4' }), /protocol/i)
  assert.equal((await rpc('initialize', { protocolVersion: 'flowm.harness/5' })).protocolVersion, 'flowm.harness/5')
  const profileId = randomUUID()
  const profile = { id: profileId, name: 'Offline gateway', kind: 'gateway', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: '', authKind: 'none', credentialVersion: 0, account: null, subject: null, clientId: null }
  const savedProfile = await rpc('profiles/save', { profile })
  const catalog = await rpc('models/list', { profileId })
  assert.equal(catalog.profileId, profileId)
  assert.equal(catalog.source, 'gateway')
  assert.ok(catalog.models.every((model) => model.origin === 'remote'), 'gateway inherited kernel candidates')
  assert.deepEqual(catalog.models.map((model) => model.id), [discoveredModel], 'gateway picker included an upstream bundled model')
  assert.equal(catalog.defaultModel, discoveredModel)
  const binding = { projectRoot: project, flowSessionId: 'flowm-test', profileId, credentialVersion: savedProfile.credentialVersion, role: 'canvas', model: discoveredModel, system: 'Test harness. Return JSON when given a schema.' }
  await assert.rejects(rpc('thread/open', { ...binding, credentialVersion: 0 }), /credentials changed/)
  await assert.rejects(rpc('thread/open', { ...binding, model: 'not-returned-by-gateway' }), /absent from.*catalog/)
  availableModels = ['newly-returned-route']
  const refreshed = await rpc('models/list', { profileId })
  assert.deepEqual(refreshed.models.map((model) => model.id), availableModels, 'model listing reused a stale snapshot')
  await assert.rejects(rpc('thread/open', binding), /absent from.*catalog/)
  availableModels = [discoveredModel]
  assert.ok(catalogRequests >= 4, 'model discovery did not reach the upstream')
  const { threadId } = await rpc('thread/open', binding)
  const schemas = ['build', 'review', 'finalize'].map((phase) => ({ type: 'object', additionalProperties: false, properties: { reply: { type: 'string', description: phase }, question: { type: 'null' }, operations: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: false }, maxItems: 0 } }, required: ['reply', 'question', 'operations'] }))
  for (const schema of schemas) {
    responses.push(message(envelope))
    const params = { threadId, requestId: randomUUID(), prompt: 'Return the checked JSON envelope', images: [], outputSchema: schema }
    const receipt = await rpc('turn/start', params)
    assert.equal(receipt.status, 'completed')
    assert.equal(receipt.text, envelope)
    const count = requests.length
    assert.equal((await rpc('turn/start', params)).text, envelope)
    assert.equal(requests.length, count, 'completed request must not execute twice')
    assert.deepEqual(requests.at(-1).text.format.schema, schema)
    assert.equal(requests.at(-1).store, false)
    assert.equal(requests.at(-1).stream, true)
    assert.equal(requests.at(-1).previous_response_id, undefined)
  }
  await assert.rejects(rpc('thread/open', { ...binding, threadId, role: 'project' }), /binding changed/)

  responses.push(tool('request_user_input', { questions: [{ id: 'direction', header: 'Direction', question: 'Choose a test direction', options: [{ label: 'Left', description: 'Use the left route' }, { label: 'Right', description: 'Use the right route' }] }] }), message(envelope))
  let resolveInput
  const inputQuestion = new Promise((resolve) => { resolveInput = resolve })
  questionListener = (params) => { if (params.threadId === threadId) resolveInput(params.event.question) }
  const inputTurn = rpc('turn/start', { threadId, requestId: randomUUID(), prompt: 'Exercise native user input', images: [], outputSchema: schemas[0] })
  const inputTimeout = new Promise((_, reject) => { setTimeout(() => reject(new Error('Native input question was not emitted')), 10000).unref() })
  const pendingInput = await Promise.race([inputQuestion, inputTimeout, inputTurn.then(() => { throw new Error('Input turn finished before its answer') })])
  await rpc('interaction/answer', { threadId, requestId: pendingInput.requestId, answers: { direction: ['Left'] } })
  await inputTurn
  questionListener = null

  // The actual OS sandbox must allow reading while refusing command-induced writes.
  if (process.platform === 'win32') {
    for (const command of ['Get-Content sample.txt', "Set-Content sample.txt 'unauthorized'"]) {
      responses.push(tool('exec_command', { cmd: command, shell: 'powershell', login: false, max_output_tokens: 1000 }), message(envelope))
      const receipt = await rpc('turn/start', { threadId, requestId: randomUUID(), prompt: 'Exercise the requested sandbox tool', images: [], outputSchema: schemas[0] })
      assert.equal(receipt.status, 'completed')
    }
    assert.equal(await readFile(join(project, 'sample.txt'), 'utf8'), 'original', 'canvas command wrote a project file')
    const statuses = events.map((event) => event.params?.event?.activity).filter((activity) => activity?.type === 'tool_status')
    assert.ok(statuses.some((activity) => activity.status === 'completed' && activity.output?.includes('original')), 'the read command did not successfully read the file')
    assert.ok(statuses.some((activity) => activity.status === 'failed'), 'the write command was not rejected')

    const { threadId: projectThread } = await rpc('thread/open', { ...binding, role: 'project', system: 'Test project permissions.' })
    responses.push(tool('exec_command', { cmd: "Set-Content created.txt 'workspace-write'", shell: 'powershell', login: false, max_output_tokens: 1000 }), message('project updated'))
    await rpc('turn/start', { threadId: projectThread, requestId: randomUUID(), prompt: 'Write only inside the test workspace', images: [], outputSchema: null })
    assert.equal((await readFile(join(project, 'created.txt'), 'utf8')).trim(), 'workspace-write')
    const outside = join(testRoot, 'approval-test.txt')
    for (const decision of ['Deny', 'Approve']) {
      responses.push(tool('exec_command', { cmd: `Set-Content -LiteralPath '${outside.replaceAll("'", "''")}' 'approved-once'`, shell: 'powershell', login: false, max_output_tokens: 1000, sandbox_permissions: 'require_escalated', justification: 'Write a controlled test file outside the test workspace' }), message('approval handled'))
      let resolveQuestion
      const question = new Promise((resolve) => { resolveQuestion = resolve })
      questionListener = (params) => { if (params.threadId === projectThread) resolveQuestion(params.event.question) }
      const turn = rpc('turn/start', { threadId: projectThread, requestId: randomUUID(), prompt: 'Exercise explicit approval in the test fixture', images: [], outputSchema: null })
      const failed = turn.catch((error) => { throw error })
      const timeout = new Promise((_, reject) => { setTimeout(() => reject(new Error('Project did not request approval')), 10000).unref() })
      const pendingQuestion = await Promise.race([question, timeout, failed.then(() => { throw new Error('Project finished before approval') })])
      await assert.rejects(access(outside), 'operation executed before approval')
      await rpc('interaction/answer', { threadId: projectThread, requestId: pendingQuestion.requestId, answers: { decision: [decision] } })
      await turn
      if (decision === 'Deny') await assert.rejects(access(outside), 'denied operation executed')
      else assert.equal((await readFile(outside, 'utf8')).trim(), 'approved-once')
      questionListener = null
    }
    await rpc('thread/close', { threadId: projectThread })
  }

  await rpc('thread/close', { threadId })
  const resumed = await rpc('thread/open', { ...binding, threadId })
  assert.equal(resumed.threadId, threadId)
  responses.push(message(envelope))
  await rpc('turn/start', { threadId, requestId: randomUUID(), prompt: 'Continue from private session history', images: [], outputSchema: schemas[0] })
  assert.ok(JSON.stringify(requests.at(-1).input).includes('Return the checked JSON envelope'), 'cold resume lost previous history')
  await rpc('thread/close', { threadId })

  const { threadId: failureThread } = await rpc('thread/open', { ...binding, flowSessionId: 'auth-failure' })
  const beforeError = requests.length
  responses.push({ status: 401 })
  const rejected = { threadId: failureThread, requestId: randomUUID(), prompt: 'Simulated auth failure', images: [], outputSchema: schemas[0] }
  await assert.rejects(rpc('turn/start', rejected))
  const receipt = await rpc('turn/status', { requestId: rejected.requestId })
  assert.notEqual(receipt.status, 'completed')
  await assert.rejects(rpc('turn/start', rejected), /not replayed/)
  assert.equal(requests.length, beforeError + 1, 'failed inference must not be automatically replayed')
  await rpc('thread/close', { threadId: failureThread })
  await rpc('thread/open', { ...binding, flowSessionId: 'auth-failure', threadId: failureThread })
  await assert.rejects(rpc('turn/start', { ...rejected, requestId: randomUUID(), prompt: 'Do not execute into an uncertain thread' }), /interrupted/)
  await rpc('thread/close', { threadId: failureThread })

  const { threadId: cancelThread } = await rpc('thread/open', { ...binding, flowSessionId: 'cancel-test' })
  const beforeHeldRequest = heldRequests
  responses.push({ hold: true })
  const cancelRequest = { threadId: cancelThread, requestId: randomUUID(), prompt: 'A held model stream', images: [], outputSchema: schemas[0] }
  const cancelled = rpc('turn/start', cancelRequest)
  const cancellationResult = assert.rejects(cancelled, /cancel|interrupt/)
  // A running receipt precedes the HTTP request. Wait until this stream fixture was actually
  // consumed so an early cancellation cannot leave it queued for the next bearer test.
  for (let attempt = 0; attempt < 500; attempt++) {
    if (heldRequests > beforeHeldRequest) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(heldRequests, beforeHeldRequest + 1, 'cancellation fixture never reached the provider')
  await rpc('turn/cancel', { threadId: cancelThread })
  await cancellationResult
  assert.notEqual((await rpc('turn/status', { requestId: cancelRequest.requestId })).status, 'completed')
  await rpc('thread/close', { threadId: cancelThread })

  const bearerProfileId = randomUUID()
  const fixtureToken = 'flowm-offline-fixture-token'
  const bearerProfile = { ...profile, id: bearerProfileId, authKind: 'bearer', name: 'Encrypted bearer fixture' }
  await rpc('profiles/save', { profile: bearerProfile, token: fixtureToken })
  assert.equal((await rpc('profiles/list')).find((profile) => profile.id === bearerProfileId).signedIn, true)
  const sealed = await readFile(join(home, 'credentials', `${bearerProfileId}.sealed`), 'utf8')
  assert.ok(!sealed.includes(fixtureToken), 'bearer token was stored in plaintext')
  const { threadId: bearerThread } = await rpc('thread/open', { ...binding, flowSessionId: 'bearer-test', profileId: bearerProfileId })
  responses.push(message(envelope))
  await rpc('turn/start', { threadId: bearerThread, requestId: randomUUID(), prompt: 'Check bearer attachment', images: [], outputSchema: schemas[0] })
  assert.equal(authorizations.at(-1), `Bearer ${fixtureToken}`)
  await rpc('auth/logout', { profileId: bearerProfileId })
  assert.equal((await rpc('profiles/list')).find((profile) => profile.id === bearerProfileId).signedIn, false)
  await assert.rejects(access(join(home, 'credentials', `${bearerProfileId}.sealed`)), 'logout retained encrypted credentials')
  assert.equal(await readFile(join(foreignHome, 'config.toml'), 'utf8'), 'INVALID EXTERNAL CONFIG: MUST NEVER BE READ')
  console.log(`Harness integration passed: ${requests.length} local Responses requests, schema changes, receipts, binding isolation, native questions, encrypted bearer/logout, provider failure, cold resume, cancellation${process.platform === 'win32' ? ', Windows read-only/workspace-write, approval allow/deny' : ''}.`)
  console.log(`Evidence directory: ${testRoot}`)
} finally {
  await writeFile(join(testRoot, 'evidence.json'), JSON.stringify({ requests, events, diagnostics }, null, 2))
  console.log(`Harness evidence: ${testRoot}`)
  child.stdin.end()
  const exited = once(child, 'exit')
  const timer = setTimeout(() => child.kill(), 15000)
  await exited
  clearTimeout(timer)
  server.closeAllConnections()
  server.close()
}
