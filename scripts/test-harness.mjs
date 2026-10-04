// Offline integration against the real, embedded kernel. Never uses a paid model or installed CLI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, stat, access } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { createServer as createViteServer } from 'vite'

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
  if (request.method === 'GET' && request.url === '/api/v1/models') {
    catalogRequests++
    assert.equal(request.headers['cache-control'], 'no-cache, no-store')
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: availableModels.map((id) => ({
      id, name: `Gateway ${id}`, context_length: 128000,
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['tools', 'structured_outputs'],
    })) }))
    return
  }
  let content = ''
  for await (const chunk of request) content += chunk
  if (request.method !== 'POST' || request.url !== '/api/v1/responses') {
    response.writeHead(404).end('unexpected route')
    return
  }
  requests.push(JSON.parse(content))
  authorizations.push(request.headers.authorization ?? null)
  const next = responses.shift()
  if (!next) { response.writeHead(500).end('No response fixture'); return }
  if (next.status) { response.writeHead(next.status).end(JSON.stringify(next.body ?? { error: { message: 'simulated provider failure' } })); return }
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  if (next.hold) { heldRequests++; response.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: randomUUID() } })}\n\n`); return }
  const events = [
    { type: 'response.created', response: { id: randomUUID() } },
    ...(next.events ?? [next]),
    ...(!next.failed ? [{ type: 'response.completed', response: { id: randomUUID(), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }] : []),
  ]
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')

let child
const pending = new Map()
const events = []
let questionListener = null
let diagnostics = ''
let rpcId = 0
function startChild() {
  const nextChild = spawn(binary, ['--home', home], { cwd: project, windowsHide: true, env: { ...process.env, CODEX_HOME: foreignHome } })
  nextChild.stderr.on('data', (data) => { diagnostics = (diagnostics + data).slice(-20000) })
  createInterface({ input: nextChild.stdout }).on('line', (line) => {
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
  nextChild.on('exit', (code) => {
  for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error(`Harness exited ${code}\n${diagnostics}`)) }
  pending.clear()
  })
  return nextChild
}
child = startChild()
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++rpcId
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}\n${diagnostics}`)) }, 60000)
  pending.set(id, { resolve, reject, timeout })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const message = (text) => ({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: randomUUID(), content: [{ type: 'output_text', text }] } })
const tool = (name, args) => ({ type: 'response.output_item.done', item: { type: 'function_call', call_id: randomUUID(), name, arguments: JSON.stringify(args) } })
const envelope = JSON.stringify({ reply: 'checked', question: null, operations: [] })

// Exercise the exact canvas contract; a tiny hand-written schema misses provider compiler limits.
const schemaServer = await createViteServer({ root, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null } })
let schemas
try {
  const { buildCanvasTurnOutputSchema } = await schemaServer.ssrLoadModule('/src/llm/outputContract.ts')
  const { canvasTools, declareDiagramTool, declareStructureTool } = await schemaServer.ssrLoadModule('/src/protocol/index.ts')
  schemas = [
    [declareDiagramTool, ...canvasTools, declareStructureTool],
    [...canvasTools.filter((tool) => ['move_shape', 'place_region'].includes(tool.name)), declareStructureTool],
    [],
  ].map((tools) => buildCanvasTurnOutputSchema(tools, 'strict'))
} finally { await schemaServer.close() }

function checkGatewayGrammar(schema) {
  let unions = 0
  function walk(value) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value.type) || Array.isArray(value.anyOf)) unions++
    for (const key of ['enum', 'required', 'anyOf', 'allOf', 'oneOf']) {
      if (Object.hasOwn(value, key)) assert.ok(Array.isArray(value[key]), `invalid schema keyword: ${key} must be an array`)
    }
    if (Object.hasOwn(value, 'enum')) assert.equal(typeof value.type, 'string', 'gateway compiler rejects nullable type arrays with enums')
    if (Object.hasOwn(value, 'properties')) assert.ok(value.properties && !Array.isArray(value.properties) && typeof value.properties === 'object', 'schema properties must be an object')
    assert.ok(value.maxItems === undefined, 'gateway compiler rejects array maxItems')
    for (const [key, child] of Object.entries(value)) if (key !== 'description') walk(child)
  }
  walk(schema)
  assert.ok(unions <= 16, `gateway compiler limit exceeded: ${unions} union parameters`)
}

try {
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/2' }), /protocol/i)
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/3' }), /protocol/i)
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/4' }), /protocol/i)
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/5' }), /protocol/i)
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/6' }), /protocol/i)
  await assert.rejects(rpc('initialize', { protocolVersion: 'flowm.harness/7' }), /protocol/i)
  assert.equal((await rpc('initialize', { protocolVersion: 'flowm.harness/8' })).protocolVersion, 'flowm.harness/8')
  const profileId = randomUUID()
  const profile = { id: profileId, name: 'Offline gateway', kind: 'gateway', baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, model: '', authKind: 'none', credentialVersion: 0, account: null, subject: null, clientId: null }
  const savedProfile = await rpc('profiles/save', { profile })
  const catalog = await rpc('models/list', { profileId })
  assert.equal(catalog.profileId, profileId)
  assert.equal(catalog.source, 'gateway')
  assert.ok(catalog.models.every((model) => model.origin === 'remote'), 'gateway inherited kernel candidates')
  assert.deepEqual(catalog.models.map((model) => model.id), [discoveredModel], 'gateway picker included an upstream bundled model')
  assert.equal(catalog.defaultModel, discoveredModel)
  assert.equal(catalog.models[0].label, `Gateway ${discoveredModel}`)
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
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABCSURBVDhP3cwxCgAgFMPQ3v/Sur+C8HERA1kCbdYlMUx58CDJUaniQKWKA5UqDlSqOFCp4kCligOVKg5Uugz54GADbQ087qcDcpoAAAAASUVORK5CYII='
  for (const schema of schemas) {
    responses.push(message(envelope))
    const params = { threadId, requestId: randomUUID(), prompt: 'Return the checked JSON envelope', images: [image], outputSchema: schema }
    const receipt = await rpc('turn/start', params)
    assert.equal(receipt.status, 'completed')
    assert.deepEqual(JSON.parse(receipt.text), JSON.parse(envelope))
    const count = requests.length
    assert.equal((await rpc('turn/start', params)).text, receipt.text)
    assert.equal(requests.length, count, 'completed request must not execute twice')
    checkGatewayGrammar(requests.at(-1).text.format.schema)
    assert.equal(requests.at(-1).text.format.schema.properties.operations.items.properties.arguments_json.type, 'string')
    assert.equal(requests.at(-1).store, false)
    assert.equal(requests.at(-1).stream, true)
    assert.equal(requests.at(-1).previous_response_id, undefined)
    assert.ok(requests.at(-1).input.some((item) => item.content?.some((content) => content.type === 'input_image' && content.image_url.startsWith('data:image/'))), 'gateway request lost the canvas image')
  }
  await assert.rejects(rpc('thread/open', { ...binding, threadId, role: 'project' }), /binding changed/)

  // A single logical canvas workflow crosses an inspection segment and a tool-free output segment.
  const stageSession = await rpc('session/create', { projectRoot: project, name: 'Controlled canvas stages' })
  const stageTurn = randomUUID()
  await rpc('session/begin', { projectRoot: project, sessionId: stageSession.id, turnId: stageTurn, role: 'canvas', text: 'Inspect then draw' })
  const inspectPolicy = { phase: 'inspect', tools: 'inspect', timeoutSecs: 600 }
  const outputPolicy = (phase) => ({ phase, tools: 'none', timeoutSecs: 600 })
  const stageBinding = { ...binding, flowSessionId: stageSession.id, userTurnId: stageTurn }
  const inspectSegment = await rpc('thread/open', { ...stageBinding, toolsDisabled: false })
  responses.push(tool('exec_command', { cmd: 'Get-Content sample.txt', shell: 'powershell', login: false, max_output_tokens: 50 }),
    message('Inspection found source marker: runtime mapping'))
  await rpc('turn/start', { threadId: inspectSegment.threadId, requestId: randomUUID(), userTurnId: stageTurn,
    prompt: 'Read context only', images: [], outputSchema: null, runtimePolicy: inspectPolicy })
  const renderSegment = await rpc('thread/open', { ...stageBinding, toolsDisabled: true })
  assert.notEqual(inspectSegment.threadId, renderSegment.threadId)
  for (const [index, phase] of ['build', 'review', 'finalize'].entries()) {
    responses.push(message(envelope))
    await rpc('turn/start', { threadId: renderSegment.threadId, requestId: randomUUID(), userTurnId: stageTurn,
      prompt: 'Produce only the canvas result', images: [], outputSchema: schemas[index], runtimePolicy: outputPolicy(phase) })
    assert.deepEqual(requests.at(-1).tools, [], 'canvas output advertised project tools')
    assert.ok(JSON.stringify(requests.at(-1).input).includes('runtime mapping'), 'output stage lost inspection context')
  }
  await rpc('session/finish', { projectRoot: project, sessionId: stageSession.id, turnId: stageTurn, status: 'completed' })
  await rpc('thread/close', { threadId: inspectSegment.threadId })
  await rpc('thread/close', { threadId: renderSegment.threadId })

  const noToolSegment = await rpc('thread/open', { ...binding, flowSessionId: 'output-cannot-run-commands', toolsDisabled: true })
  const noToolRequest = randomUUID()
  responses.push(tool('exec_command', { cmd: 'echo forbidden', shell: 'powershell', login: false }))
  await assert.rejects(rpc('turn/start', { threadId: noToolSegment.threadId, requestId: noToolRequest, prompt: 'Canvas output only',
    images: [], outputSchema: schemas[0], runtimePolicy: outputPolicy('build') }), /project tools are disabled/)
  assert.ok(!events.some((event) => event.params?.requestId === noToolRequest && event.params?.event?.activity?.type === 'tool'), 'output command executed before rejection')
  await rpc('thread/close', { threadId: noToolSegment.threadId })

  const repeatSegment = await rpc('thread/open', { ...binding, flowSessionId: 'repeated-tools-within-timeout' })
  const repeatRequest = randomUUID()
  for (let count = 0; count < 3; count++) responses.push(tool('exec_command', { cmd: 'echo ok', shell: 'powershell', login: false, max_output_tokens: 50 }))
  responses.push(message('Repeated inspection completed within the deadline'))
  await rpc('turn/start', { threadId: repeatSegment.threadId, requestId: repeatRequest, prompt: 'Permit repeated calls within the total deadline',
    images: [], outputSchema: null, runtimePolicy: inspectPolicy })
  assert.equal(events.filter((event) => event.params?.requestId === repeatRequest && event.params?.event?.activity?.type === 'tool').length, 3, 'time-bounded inspection retained a repetition limit')
  await rpc('thread/close', { threadId: repeatSegment.threadId })

  const timeoutSegment = await rpc('thread/open', { ...binding, flowSessionId: 'absolute-stage-timeout' })
  const timeoutRequest = { threadId: timeoutSegment.threadId, requestId: randomUUID(), prompt: 'Bound a held model stream',
    images: [], outputSchema: null, runtimePolicy: { ...inspectPolicy, timeoutSecs: 1 } }
  responses.push({ hold: true })
  const timeoutStarted = Date.now()
  await assert.rejects(rpc('turn/start', timeoutRequest), /timed out|deadline/i)
  assert.ok(Date.now() - timeoutStarted < 10000, 'a held stream outlived its absolute deadline')
  assert.notEqual((await rpc('turn/status', { requestId: timeoutRequest.requestId })).status, 'completed')
  const callsAfterTimeout = requests.length
  await assert.rejects(rpc('turn/start', timeoutRequest), /not replayed/)
  assert.equal(requests.length, callsAfterTimeout)
  await rpc('thread/close', { threadId: timeoutSegment.threadId })

  if (process.platform === 'win32') {
    const timedToolSegment = await rpc('thread/open', { ...binding, flowSessionId: 'timeout-stops-command', role: 'project' })
    responses.push(tool('exec_command', { cmd: "Start-Sleep -Seconds 4; Set-Content timeout-marker.txt 'late'", shell: 'powershell', login: false, max_output_tokens: 50 }))
    await assert.rejects(rpc('turn/start', { threadId: timedToolSegment.threadId, requestId: randomUUID(), prompt: 'Cancel the running tool at the stage deadline',
      images: [], outputSchema: null, runtimePolicy: { phase: 'project', tools: 'workspace', timeoutSecs: 1 } }), /timed out|deadline/i)
    await new Promise((resolve) => setTimeout(resolve, 4500))
    await assert.rejects(access(join(project, 'timeout-marker.txt')), 'timed-out command kept running after cancellation')
    await rpc('thread/close', { threadId: timedToolSegment.threadId })
  }

  const encoded = { reply: 'Declared', question: null, operations: [{ op: 'declare_diagram', arguments_json: JSON.stringify({ kind: 'process', focus: 'Fixture', regions: [{ ref: 'main', kind: 'process', purpose: 'Fixture', primaryRefs: ['a'] }] }) }] }
  responses.push(message(JSON.stringify(encoded)))
  const adapted = await rpc('turn/start', { threadId, requestId: randomUUID(), prompt: 'Check structured operation adaptation', images: [], outputSchema: schemas[0] })
  assert.equal(JSON.parse(adapted.text).operations[0].kind, 'process')
  assert.equal(JSON.parse(adapted.text).operations[0].arguments_json, undefined)

  const { threadId: streamingThread } = await rpc('thread/open', { ...binding, flowSessionId: 'gateway-stream', role: 'project' })
  const streamingRequest = randomUUID()
  const messageId = randomUUID()
  responses.push({ events: [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: messageId, role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: messageId, output_index: 0, content_index: 0, delta: 'Gateway ' },
    { type: 'response.output_text.delta', item_id: messageId, output_index: 0, content_index: 0, delta: 'streamed' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: messageId, role: 'assistant', content: [{ type: 'output_text', text: 'Gateway streamed' }] } },
  ] })
  const streamed = await rpc('turn/start', { threadId: streamingThread, requestId: streamingRequest, prompt: 'Stream this gateway response', images: [], outputSchema: null })
  assert.equal(streamed.text, 'Gateway streamed')
  assert.equal(events.filter((event) => event.params?.requestId === streamingRequest && event.params?.event?.kind === 'text').map((event) => event.params.event.text).join(''), streamed.text)
  await rpc('thread/close', { threadId: streamingThread })

  const { threadId: unavailableThread } = await rpc('thread/open', { ...binding, flowSessionId: 'gateway-unavailable' })
  const unavailableRequest = randomUUID()
  responses.push({ failed: true, events: [{ type: 'response.failed', response: { id: randomUUID(), status: 'failed', error: { code: 'model_not_found', message: 'Gateway model is not available' } } }] })
  await assert.rejects(rpc('turn/start', { threadId: unavailableThread, requestId: unavailableRequest, prompt: 'Report a returned model error', images: [], outputSchema: schemas[0] }), /model is not available/)
  assert.notEqual((await rpc('turn/status', { requestId: unavailableRequest })).status, 'completed')
  await rpc('thread/close', { threadId: unavailableThread })

  const { threadId: wrappedErrorThread } = await rpc('thread/open', { ...binding, flowSessionId: 'gateway-wrapped-error' })
  const wrappedRequest = randomUUID()
  const wrappedMessage = 'output_config.format.schema: Invalid JSON Schema in output format: None is not of type array'
  responses.push({ status: 400, body: { error: { message: 'Provider returned error', code: 400, metadata: {
    raw: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: wrappedMessage } }), provider_name: 'Google',
  } }, user_id: 'private-fixture-account' } })
  await assert.rejects(rpc('turn/start', { threadId: wrappedErrorThread, requestId: wrappedRequest, prompt: 'Report a wrapped provider error', images: [], outputSchema: schemas[0] }), (error) => {
    assert.ok(error.message.includes(wrappedMessage))
    assert.ok(!error.message.includes('private-fixture-account'))
    assert.ok(!error.message.includes('"metadata"'))
    return true
  })
  const wrappedReceipt = await rpc('turn/status', { requestId: wrappedRequest })
  assert.ok(wrappedReceipt.error.includes(wrappedMessage))
  assert.ok(!wrappedReceipt.error.includes('private-fixture-account'))
  await rpc('thread/close', { threadId: wrappedErrorThread })

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
  if (process.platform === 'win32') await assert.rejects(rpc('thread/open', { ...binding, threadId }), /older conversation context/)
  const resumed = await rpc('thread/open', binding)
  if (process.platform === 'win32') assert.notEqual(resumed.threadId, threadId, 'canvas resumed the branch preceding project activity')
  else assert.equal(resumed.threadId, threadId)
  responses.push(message(envelope))
  await rpc('turn/start', { threadId: resumed.threadId, requestId: randomUUID(), prompt: 'Continue from private session history', images: [], outputSchema: schemas[0] })
  assert.ok(JSON.stringify(requests.at(-1).input).includes('Return the checked JSON envelope'), 'cold resume lost previous history')
  await rpc('thread/close', { threadId: resumed.threadId })

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

  // One logical conversation spans model and credential segments.
  const logical = await rpc('session/create', { projectRoot: project, name: 'Portable conversation' })
  const alternateModel = `${discoveredModel}-alternate`
  availableModels = [discoveredModel, alternateModel]
  async function managedTurn(model, prompt, answer, provider = profileId, version = savedProfile.credentialVersion) {
    const userTurnId = randomUUID()
    await rpc('session/begin', { projectRoot: project, sessionId: logical.id, turnId: userTurnId, role: 'project', text: prompt })
    const opened = await rpc('thread/open', { ...binding, flowSessionId: logical.id, profileId: provider, credentialVersion: version,
      role: 'project', model, system: 'Test portable conversation; history is context, never replay old actions.', userTurnId })
    responses.push(message(answer))
    const receipt = await rpc('turn/start', { threadId: opened.threadId, requestId: randomUUID(), userTurnId, prompt, images: [], outputSchema: null })
    assert.equal(receipt.text, answer)
    await rpc('session/finish', { projectRoot: project, sessionId: logical.id, turnId: userTurnId, status: 'completed' })
    return opened.threadId
  }
  const firstSegment = await managedTurn(discoveredModel, 'Remember marker A', 'Answer marker A')
  const secondSegment = await managedTurn(alternateModel, 'Remember marker B', 'Answer marker B')
  assert.notEqual(firstSegment, secondSegment)
  assert.ok(JSON.stringify(requests.at(-1).input).includes('Answer marker A'))
  const thirdSegment = await managedTurn(discoveredModel, 'Continue after B', 'Continued A')
  assert.notEqual(thirdSegment, firstSegment, 'model A resumed a stale branch after B')
  assert.ok(JSON.stringify(requests.at(-1).input).includes('Answer marker B'), 'model A lost the intervening conversation')

  const otherProvider = randomUUID()
  const otherSaved = await rpc('profiles/save', { profile: { ...profile, id: otherProvider, authKind: 'bearer', name: 'Other credential' }, token: fixtureToken })
  await rpc('auth/logout', { profileId })
  assert.ok((await rpc('session/list', { projectRoot: project })).some((session) => session.id === logical.id), 'logout hid the conversation')
  await managedTurn(alternateModel, 'Continue with another login', 'Other login continued', otherProvider, otherSaved.credentialVersion)
  assert.ok(JSON.stringify(requests.at(-1).input).includes('Answer marker B'))
  assert.equal(authorizations.at(-1), `Bearer ${fixtureToken}`)
  await rpc('auth/logout', { profileId: otherProvider })
  const reconnected = await rpc('profiles/save', { profile })
  await managedTurn(discoveredModel, 'Return with fresh credentials', 'Fresh login continued', profileId, reconnected.credentialVersion)
  assert.ok(JSON.stringify(requests.at(-1).input).includes('Other login continued'))

  const portable = await rpc('session/export', { projectRoot: project, sessionId: logical.id })
  assert.ok(portable.events.some((event) => event.kind === 'model_result'))
  const imported = await rpc('session/import-begin', { projectRoot: project, name: 'Imported portable conversation' })
  for (const event of portable.events) await rpc('session/import-events', { projectRoot: project, sessionId: imported.id, events: [event] })
  assert.ok(!(await rpc('session/list', { projectRoot: project })).some((session) => session.id === imported.id), 'an uncommitted import was published')
  await rpc('session/import-commit', { projectRoot: project, sessionId: imported.id })
  assert.ok((await rpc('session/list', { projectRoot: project })).some((session) => session.id === imported.id))

  // Stop after durable user input. Restart must restore a stopped turn without inference.
  const interruptedId = randomUUID()
  await rpc('session/begin', { projectRoot: project, sessionId: logical.id, turnId: interruptedId, role: 'project', text: 'Durable unfinished user input' })
  const countBeforeRestart = requests.length
  const old = child
  const stopped = once(old, 'exit')
  old.kill()
  await stopped
  child = startChild()
  await rpc('initialize', { protocolVersion: 'flowm.harness/8' })
  const restored = await rpc('session/read', { projectRoot: project, sessionId: logical.id })
  assert.equal(restored.meta.id, logical.id)
  assert.equal(restored.activeTurnId, null)
  assert.ok(restored.events.some((event) => event.kind === 'turn_end' && event.turnId === interruptedId && event.data.status === 'interrupted'))
  assert.equal(requests.length, countBeforeRestart, 'restart replayed a request')
  await managedTurn(discoveredModel, 'Explicit new request after restart', 'Restart continued', profileId, reconnected.credentialVersion)
  assert.ok(JSON.stringify(requests.at(-1).input).includes('Fresh login continued'))

  const privateState = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))
  const ownedBindings = Object.values(privateState.bindings).filter((candidate) => candidate.flowSessionId === logical.id)
  await rpc('session/delete', { projectRoot: project, sessionId: logical.id })
  const deletedState = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))
  assert.ok(!Object.values(deletedState.bindings).some((candidate) => candidate.flowSessionId === logical.id))
  for (const candidate of ownedBindings) await assert.rejects(access(candidate.rolloutPath), 'delete retained private model history')
  await assert.rejects(rpc('session/read', { projectRoot: project, sessionId: logical.id }), /not found/)
  assert.ok((await rpc('session/list', { projectRoot: project })).some((session) => session.id === imported.id), 'deletion crossed conversation boundaries')

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
