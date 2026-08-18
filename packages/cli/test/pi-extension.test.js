import assert from 'node:assert/strict'
import test from 'node:test'

import { createMemorySecretStore } from '../src/auth/secret-store.js'
import {
  compactTinyEdgeHistory,
  createTinyEdgePiExtension,
  isFreshBenchmarkRequest,
} from '../src/pi-extension.js'

function fakePi() {
  return {
    commands: new Map(),
    handlers: new Map(),
    tools: new Map(),
    activeTools: [],
    registerCommand(name, command) { this.commands.set(name, command) },
    registerTool(tool) { this.tools.set(tool.name, tool) },
    on(name, handler) { this.handlers.set(name, handler) },
    getActiveTools() { return [...this.activeTools] },
    setActiveTools(names) { this.activeTools = [...names] },
  }
}

function fakeContext(messages) {
  return {
    mode: 'tui',
    model: { provider: 'test', id: 'model' },
    ui: {
      notify(message, level) { messages.push({ message, level }) },
      setHeader() {},
    },
  }
}

test('existing Pi extension registers commands and scope-bound TinyEdge tools', async () => {
  const pi = fakePi()
  const messages = []
  let saved = null
  let loginScopesSeen
  const extension = createTinyEdgePiExtension({
    platform: 'win32',
    createConfigImpl: () => ({
      baseUrl: 'https://tinyedge.ai', mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\test', scopes: ['tinyedge:read'],
    }),
    createSecretStoreImpl: () => createMemorySecretStore(),
    createTokenStoreImpl: () => ({
      async summary() { return saved ? { connected: true, scope: saved.scope.split(' ') } : { connected: false } },
      async load() { return saved }, async save(value) { saved = value }, async clear() { saved = null },
    }),
    loginImpl: async ({ config, tokenStore }) => {
      loginScopesSeen = config.scopes
      await tokenStore.save({ accessToken: 'opaque', resource: config.mcpUrl, scope: config.scopes.join(' ') })
    },
    logoutImpl: async ({ tokenStore }) => tokenStore.clear(),
    createAuthenticatedMcpImpl: async () => ({
      client: {
        async listTools() { return [{ name: 'list_tasks' }, { name: 'run_benchmark' }] },
        async callTool() { return { structuredContent: {} } },
      },
    }),
    createToolsImpl: ({ allowedTools }) => allowedTools
      .filter((name) => name === 'list_tasks' || name === 'run_benchmark')
      .map((name) => ({ name })),
    defineToolImpl: (value) => value,
  })

  extension(pi)
  assert.deepEqual([...pi.commands.keys()], [
    'tinyedge-login', 'tinyedge-status', 'tinyedge-tools', 'tinyedge-devices', 'tinyedge-logout',
  ])
  await pi.commands.get('tinyedge-login').handler('--allow-run', fakeContext(messages))
  assert.deepEqual(loginScopesSeen, ['tinyedge:read', 'tinyedge:run'])
  assert.deepEqual([...pi.tools.keys()], ['ask_choice', 'list_tasks', 'run_benchmark'])
  assert.match(messages.at(-1).message, /2 tools available/)

  await pi.commands.get('tinyedge-logout').handler('', fakeContext(messages))
  assert.equal((await pi.commands.get('tinyedge-status').handler('', fakeContext(messages))), undefined)
  assert.match(messages.at(-1).message, /not connected/)
})

test('existing Pi extension uses the Pi-compatible identity tool definition by default', async () => {
  const pi = fakePi()
  const messages = []
  createTinyEdgePiExtension({
    platform: 'win32',
    createConfigImpl: () => ({
      baseUrl: 'https://tinyedge.ai', mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\test', scopes: ['tinyedge:read'],
    }),
    createSecretStoreImpl: () => createMemorySecretStore(),
    createTokenStoreImpl: () => ({
      async summary() { return { connected: true, scope: ['tinyedge:read'] } },
    }),
    createAuthenticatedMcpImpl: async () => ({
      client: {
        async listTools() { return [{ name: 'list_devices' }] },
        async callTool() { return { structuredContent: { devices: [] } } },
      },
    }),
    createToolsImpl: ({ sdk }) => [sdk.defineTool({ name: 'list_devices' })],
  })(pi)

  await pi.handlers.get('session_start')({}, fakeContext(messages))
  assert.deepEqual([...pi.tools.keys()], ['ask_choice', 'list_devices'])
})

test('standalone Harness blocks direct shell and non-TinyEdge tools', async () => {
  const pi = fakePi()
  createTinyEdgePiExtension({
    standalone: true,
    createConfigImpl: () => ({
      baseUrl: 'https://tinyedge.ai', mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\test', scopes: ['tinyedge:read'],
    }),
    createSecretStoreImpl: () => createMemorySecretStore(),
    createTokenStoreImpl: () => ({ async summary() { return { connected: false } } }),
    defineToolImpl: (value) => value,
  })(pi)

  assert.deepEqual(await pi.handlers.get('user_bash')({ command: 'whoami' }), {
    result: {
      output: 'Shell access is disabled in TinyEdge Harness.',
      exitCode: 126,
      cancelled: false,
      truncated: false,
    },
  })
  assert.deepEqual(await pi.handlers.get('tool_call')({ toolName: 'bash' }), {
    block: true,
    reason: 'Only reviewed TinyEdge tools are available in this Harness.',
  })
})

test('Harness gives a fresh benchmark request a deterministic question-first tool boundary', async () => {
  assert.equal(isFreshBenchmarkRequest('Can you benchmark my Basler camera on my Raspberry Pi?'), true)
  assert.equal(isFreshBenchmarkRequest('Resume my existing Basler benchmark task'), false)
  assert.equal(isFreshBenchmarkRequest('Show the results from my previous benchmark run'), false)

  const pi = fakePi()
  const messages = []
  createTinyEdgePiExtension({
    standalone: true,
    createConfigImpl: () => ({
      baseUrl: 'https://tinyedge.ai', mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\test', scopes: ['tinyedge:read'],
    }),
    createSecretStoreImpl: () => createMemorySecretStore(),
    createTokenStoreImpl: () => ({
      async summary() { return { connected: true, scope: ['tinyedge:read'] } },
    }),
    createAuthenticatedMcpImpl: async () => ({
      client: {
        async listTools() {
          return [{ name: 'list_devices' }, { name: 'list_tasks' }, { name: 'list_models' }]
        },
        async callTool(name) {
          return { structuredContent: { [name === 'list_devices' ? 'devices' : 'items']: [] } }
        },
      },
    }),
    createToolsImpl: ({ allowedTools }) => allowedTools
      .filter((name) => ['list_devices', 'list_tasks', 'list_models'].includes(name))
      .map((name) => ({ name })),
    defineToolImpl: (value) => value,
  })(pi)

  await pi.handlers.get('session_start')({}, fakeContext(messages))
  pi.handlers.get('before_agent_start')({
    prompt: 'Can you benchmark my Basler camera on my Raspberry Pi?',
  })

  assert.equal(pi.handlers.get('tool_call')({ toolName: 'list_devices' }), undefined)
  assert.equal(pi.handlers.get('tool_call')({ toolName: 'ask_choice' }), undefined)
  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'list_devices' }), {
    block: true,
    reason: 'The device was already checked for this request. Ask the user one concise intake question now.',
  })
  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'list_tasks' }), {
    block: true,
    reason: 'Start this new benchmark by verifying the named device and asking one question. Do not inspect saved work or select artifacts yet.',
  })
  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'list_models' }), {
    block: true,
    reason: 'Start this new benchmark by verifying the named device and asking one question. Do not inspect saved work or select artifacts yet.',
  })

  assert.equal(pi.handlers.has('agent_end'), false)
  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'list_tasks' }), {
    block: true,
    reason: 'Start this new benchmark by verifying the named device and asking one question. Do not inspect saved work or select artifacts yet.',
  })
  pi.handlers.get('agent_settled')()
  assert.equal(pi.handlers.get('tool_call')({ toolName: 'list_tasks' }), undefined)
})

test('Harness compacts stale TinyEdge tool envelopes before restoring model context', () => {
  const oldEnvelope = {
    content: [{ type: 'text', text: '{"tasks":"duplicated"}' }],
    structuredContent: {
      tasks: [{
        id: 'task-basler',
        title: 'Basler camera benchmark',
        state: 'intake',
        requirements: {
          modelId: 'builtin-yolox-nano-416',
          notes: 'Representative workload trace not yet available.',
        },
      }],
    },
  }
  const original = {
    role: 'toolResult',
    toolCallId: 'old-list',
    toolName: 'list_tasks',
    content: [{ type: 'text', text: JSON.stringify(oldEnvelope) }],
    details: { access_token: 'details-must-not-leak' },
    isError: false,
    timestamp: 1,
  }
  const userMessage = { role: 'user', content: 'hello', timestamp: 2 }

  const compacted = compactTinyEdgeHistory([userMessage, original])
  assert.equal(compacted[0], userMessage)
  assert.notEqual(compacted[1], original)
  assert.deepEqual(JSON.parse(compacted[1].content[0].text), {
    tasks: [{ id: 'task-basler', title: 'Basler camera benchmark' }],
    total: 1,
    truncated: false,
  })
  assert.equal(compacted[1].details.displaySummary, 'Found 1 saved benchmark task')
  assert.deepEqual(compacted[1].details, { displaySummary: 'Found 1 saved benchmark task' })
  assert.doesNotMatch(compacted[1].content[0].text, /yolox|Representative workload|"state"|structuredContent/)
  assert.match(original.content[0].text, /yolox/)
})

test('Harness restores failed or malformed discovery history without leaking or crashing', () => {
  const [failed, malformed] = compactTinyEdgeHistory([
    {
      role: 'toolResult',
      toolCallId: 'failed-list',
      toolName: 'list_devices',
      content: [{ type: 'text', text: 'Bearer secret-value could not list devices' }],
      isError: true,
    },
    {
      role: 'toolResult',
      toolCallId: 'malformed-list',
      toolName: 'list_devices',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, access_token: 'must-not-leak' }) }],
      isError: false,
    },
  ])

  assert.match(failed.content[0].text, /Bearer \[REDACTED\]/)
  assert.doesNotMatch(failed.content[0].text, /secret-value/)
  assert.equal(failed.details.displaySummary, 'TinyEdge request failed')

  assert.equal(malformed.isError, true)
  assert.equal(malformed.details.displaySummary, 'Invalid TinyEdge history entry omitted')
  assert.match(malformed.content[0].text, /history entry omitted/)
  assert.doesNotMatch(malformed.content[0].text, /must-not-leak|access_token/)
})
