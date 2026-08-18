import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTinyEdgePiTools,
  createTinyEdgePiSession,
  TINYEDGE_CHAT_TOOL_ALLOWLIST,
  tinyEdgeSystemPrompt,
  toolsForScopes,
} from '../src/chat/pi-session.js'
import { createMemorySecretStore } from '../src/auth/secret-store.js'
import { chatCommand } from '../src/commands/chat.js'

function fakeSdk(capture) {
  const session = {
    subscribe() { return () => {} },
    prompt: async () => {},
    dispose() {},
  }
  return {
    defineTool: (definition) => definition,
    DefaultResourceLoader: class {
      constructor(options) { capture.loader = options }
      async reload() { capture.reloaded = true }
    },
    ModelRuntime: {
      async create(options) {
        capture.runtime = options
        return { getAvailable: async () => [{ provider: 'openai', id: 'gpt-test' }] }
      },
    },
    SettingsManager: {
      inMemory() { capture.settings = true; return {} },
    },
    SessionManager: {
      inMemory(cwd) { capture.sessionCwd = cwd; return {} },
    },
    async createAgentSession(options) {
      capture.agent = options
      return { session }
    },
  }
}

test('Pi session disables every ambient and built-in capability and exposes only allowed MCP tools', async () => {
  const capture = {}
  const calls = []
  const mcpClient = {
    listTools: async () => [
      { name: 'list_devices', description: 'List devices', inputSchema: { type: 'object' } },
      { name: 'list_models', description: 'List models', inputSchema: { type: 'object' } },
      { name: 'compare_runs', description: 'Must not be exposed without run discovery', inputSchema: { type: 'object' } },
      { name: 'run_benchmark', description: 'Must not be exposed', inputSchema: { type: 'object' } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args })
      return { structuredContent: { devices: [], access_token: 'must-not-leak' } }
    },
  }
  const created = await createTinyEdgePiSession({
    config: { configDir: 'C:\\tinyedge-test' },
    mcpClient,
    cwd: 'C:\\work',
    sdk: fakeSdk(capture),
    secretStore: createMemorySecretStore(),
  })

  assert.equal(capture.reloaded, true)
  assert.deepEqual(
    {
      noExtensions: capture.loader.noExtensions,
      noSkills: capture.loader.noSkills,
      noPromptTemplates: capture.loader.noPromptTemplates,
      noThemes: capture.loader.noThemes,
      noContextFiles: capture.loader.noContextFiles,
    },
    {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  )
  assert.equal(capture.agent.noTools, 'all')
  assert.deepEqual(capture.agent.tools, ['list_devices', 'list_models'])
  assert.deepEqual(created.tools, ['list_devices', 'list_models'])
  assert.equal(created.model, 'openai/gpt-test')
  assert.equal(capture.runtime.allowModelNetwork, false)
  assert.equal(capture.runtime.refreshOnCreate, false)
  assert.match(capture.loader.systemPrompt, /call list_runs in this chat/i)
  assert.match(capture.loader.systemPrompt, /new intake unless the user explicitly asks to resume/i)
  assert.match(capture.loader.systemPrompt, /ask exactly one question/i)
  assert.match(capture.loader.systemPrompt, /Do not call list_tasks, list_models, or list_datasets/i)
  assert.equal(capture.agent.customTools.some((tool) => tool.name === 'compare_runs'), false)

  const result = await capture.agent.customTools[0].execute('call-one', { includeOffline: true })
  assert.deepEqual(calls, [{ name: 'list_devices', args: { includeOffline: true } }])
  assert.doesNotMatch(result.content[0].text, /must-not-leak/)
  assert.deepEqual(JSON.parse(result.content[0].text), {
    devices: [], total: 0, truncated: false,
  })
})

test('discovery tools keep raw account records out of the transcript and render compact summaries', async () => {
  const tasks = Array.from({ length: 30 }, (_, index) => ({
    id: `task-${index}`,
    title: `Camera benchmark ${index}`,
    state: 'intake',
    updatedAt: `2026-08-${String(index + 1).padStart(2, '0')}`,
    requirements: { modelId: 'builtin-yolox-nano-416' },
    notes: 'Representative workload trace not yet available.',
    access_token: 'must-not-leak',
  }))
  const tools = createTinyEdgePiTools({
    sdk: { defineTool: (definition) => definition },
    mcpClient: {
      async callTool(name, args) {
        if (name === 'get_benchmark_brief') {
          return { structuredContent: { task: { id: args.taskId, title: 'Selected task' } } }
        }
        assert.equal(name, 'list_tasks')
        return {
          content: [{ type: 'text', text: JSON.stringify({ tasks }) }],
          structuredContent: { tasks },
        }
      },
    },
    advertisedTools: [
      { name: 'list_tasks', inputSchema: { type: 'object' } },
      { name: 'get_benchmark_brief', inputSchema: { type: 'object' } },
    ],
    allowedTools: ['list_tasks', 'get_benchmark_brief'],
  })

  const result = await tools[0].execute('discover-tasks', {})
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.total, 30)
  assert.equal(payload.truncated, true)
  assert.equal(payload.tasks.length, 25)
  assert.equal(
    payload.selectionNotice,
    'Only the first 25 of 30 items can be selected in this preview.',
  )
  assert.deepEqual(payload.tasks[0], {
    id: 'task-0',
    title: 'Camera benchmark 0',
    updatedAt: '2026-08-01',
  })
  assert.doesNotMatch(result.content[0].text, /modelId|Representative workload|must-not-leak|"state"|structuredContent/)
  assert.equal(result.details.displaySummary, 'Found 30 saved benchmark tasks · showing 25; 5 omitted')
  assert.match(tools[0].description, /only when the user explicitly asks to list, inspect, or resume/i)
  assert.match(tools[0].description, /Never call it during a new benchmark intake/i)

  const theme = { fg: (_color, value) => value, bold: (value) => value }
  assert.deepEqual(tools[0].renderCall({}, theme, {}).render(80), [
    'Checking saved benchmark tasks',
  ])
  assert.deepEqual(tools[0].renderResult(result, { expanded: false }, theme, {
    isError: false,
  }).render(80), ['Found 30 saved benchmark tasks · showing 25; 5 omitted'])
  const expanded = tools[0].renderResult(result, { expanded: true }, theme, {
    isError: false,
  }).render(80).join('\n')
  assert.match(expanded, /task-0/)
  assert.doesNotMatch(expanded, /Representative workload|must-not-leak|modelId|"state"/)
  assert.ok(expanded.split('\n').length <= 14)

  await assert.rejects(
    tools[1].execute('hidden-task', { taskId: 'task-29' }),
    /Call list_tasks first and use an exact task ID/,
  )
  await assert.doesNotReject(tools[1].execute('visible-task', { taskId: 'task-0' }))
})

test('device discovery hides key records and statistics behind a human summary', async () => {
  const tools = createTinyEdgePiTools({
    sdk: { defineTool: (definition) => definition },
    mcpClient: {
      async callTool() {
        return {
          structuredContent: {
            devices: [{
              id: 'device-key-uuid',
              device: 'raspberry-pi-5',
              model: 'Raspberry Pi 5 Model B Rev 1.1',
              available: true,
              stats: { earnedCents: 26503, uptimeHours: 594.9 },
              access_token: 'must-not-leak',
            }],
          },
        }
      },
    },
    advertisedTools: [{ name: 'list_devices', inputSchema: { type: 'object' } }],
    allowedTools: ['list_devices'],
  })

  const result = await tools[0].execute('discover-devices', {})
  assert.deepEqual(JSON.parse(result.content[0].text), {
    devices: [{
      device: 'raspberry-pi-5',
      model: 'Raspberry Pi 5 Model B Rev 1.1',
      available: true,
    }],
    total: 1,
    truncated: false,
  })
  assert.doesNotMatch(result.content[0].text, /device-key-uuid|earnedCents|uptimeHours|must-not-leak/)

  const theme = { fg: (_color, value) => value, bold: (value) => value }
  const collapsed = tools[0].renderResult(result, { expanded: false }, theme, {
    isError: false,
  }).render(80).join('\n')
  assert.equal(collapsed, 'Found 1 registered device')
  assert.doesNotMatch(collapsed, /raspberry|device-key-uuid/)
})

test('MCP discovery failures cannot be rendered as a successful empty list', async () => {
  const tools = createTinyEdgePiTools({
    sdk: { defineTool: (definition) => definition },
    mcpClient: {
      async callTool() {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: 'Bearer secret-value failed' }) }],
          structuredContent: { error: 'Bearer secret-value failed' },
        }
      },
    },
    advertisedTools: [{ name: 'list_devices', inputSchema: { type: 'object' } }],
    allowedTools: ['list_devices'],
  })

  await assert.rejects(tools[0].execute('failed-list', {}), (error) => {
    assert.match(error.message, /TinyEdge request failed/)
    assert.match(error.message, /Bearer \[REDACTED\]/)
    assert.doesNotMatch(error.message, /secret-value/)
    return true
  })

  const malformed = createTinyEdgePiTools({
    sdk: { defineTool: (definition) => definition },
    mcpClient: {
      async callTool() {
        return { structuredContent: { ok: true } }
      },
    },
    advertisedTools: [{ name: 'list_devices', inputSchema: { type: 'object' } }],
    allowedTools: ['list_devices'],
  })
  await assert.rejects(
    malformed[0].execute('malformed-list', {}),
    /TinyEdge list_devices returned an invalid discovery response/,
  )
})

test('task, model, dataset, and capture tools require exact IDs from bounded discovery', async () => {
  const calls = []
  const mcpClient = {
    async callTool(name, args) {
      calls.push({ name, args })
      if (name === 'list_tasks') {
        return { structuredContent: { tasks: [{ id: 'task-exact' }, { id: 'task-other' }] } }
      }
      if (name === 'list_models') {
        return { structuredContent: { models: [{ id: 'model-exact', name: 'Exact model' }] } }
      }
      if (name === 'list_datasets') {
        return { structuredContent: { datasets: [{ id: 'dataset-exact', name: 'Exact dataset' }] } }
      }
      if (name === 'list_capture_sessions') {
        return {
          structuredContent: {
            captureSessions: [{
              id: 'capture-exact', studyId: args.taskId, state: 'running', method: 'camera',
            }],
          },
        }
      }
      if (name === 'cancel_capture') {
        return {
          structuredContent: {
            captureSession: { id: args.sessionId, studyId: args.taskId, state: 'canceled' },
          },
        }
      }
      if (name === 'bind_model') {
        return { structuredContent: { task: { id: args.taskId }, model: { id: args.modelId } } }
      }
      if (name === 'bind_dataset') {
        return { structuredContent: { task: { id: args.taskId }, dataset: { id: args.datasetId } } }
      }
      if (name === 'plan_experiment') {
        return { structuredContent: { status: 'approval_required' } }
      }
      return { structuredContent: { taskId: args.taskId, capturePlan: { ready: true } } }
    },
  }
  const allowedTools = [
    'list_tasks', 'list_models', 'list_datasets', 'list_capture_sessions',
    'bind_model', 'bind_dataset', 'plan_capture', 'plan_experiment', 'cancel_capture',
  ]
  const tools = new Map(createTinyEdgePiTools({
    sdk: { defineTool: (definition) => definition },
    mcpClient,
    advertisedTools: allowedTools.map((name) => ({ name, inputSchema: { type: 'object' } })),
    allowedTools,
  }).map((tool) => [tool.name, tool]))

  await assert.rejects(
    tools.get('list_capture_sessions').execute('captures-before-task', { taskId: 'task-exact' }),
    /Call list_tasks first/,
  )
  await tools.get('list_tasks').execute('tasks', {})
  await assert.rejects(
    tools.get('plan_capture').execute('plan-unknown-task', { taskId: 'task-unknown', method: 'camera' }),
    /exact task ID/,
  )
  await assert.rejects(
    tools.get('bind_model').execute('bind-before-models', {
      taskId: 'task-exact', modelId: 'model-exact',
    }),
    /Call list_models first/,
  )
  await tools.get('list_models').execute('models', {})
  await assert.rejects(
    tools.get('bind_model').execute('bind-invented-model', {
      taskId: 'task-exact', modelId: 'model-invented',
    }),
    /exact model ID/,
  )
  await tools.get('bind_model').execute('bind-model', {
    taskId: 'task-exact', modelId: 'model-exact',
  })

  await assert.rejects(
    tools.get('bind_dataset').execute('bind-before-datasets', {
      taskId: 'task-exact', datasetId: 'dataset-exact',
    }),
    /Call list_datasets first/,
  )
  await tools.get('list_datasets').execute('datasets', {})
  await tools.get('bind_dataset').execute('bind-dataset', {
    taskId: 'task-exact', datasetId: 'dataset-exact',
  })
  await assert.rejects(
    tools.get('plan_experiment').execute('plan-invented-source', {
      sourceModelId: 'model-invented', datasetId: 'dataset-exact',
    }),
    /exact model ID/,
  )
  await tools.get('plan_experiment').execute('plan-experiment', {
    sourceModelId: 'model-exact', datasetId: 'dataset-exact',
  })

  await tools.get('plan_capture').execute('plan-capture', {
    taskId: 'task-exact', method: 'camera',
  })
  await tools.get('list_capture_sessions').execute('capture-sessions', {
    taskId: 'task-exact',
  })
  await assert.rejects(
    tools.get('cancel_capture').execute('cancel-mismatched-task', {
      taskId: 'task-other', sessionId: 'capture-exact',
    }),
    /exact task and capture session pair/,
  )
  await tools.get('cancel_capture').execute('cancel-capture', {
    taskId: 'task-exact', sessionId: 'capture-exact',
  })

  assert.deepEqual(calls.map(({ name }) => name), [
    'list_tasks', 'list_models', 'bind_model', 'list_datasets', 'bind_dataset',
    'plan_experiment', 'plan_capture', 'list_capture_sessions', 'cancel_capture',
  ])
})

test('new benchmark intake instructions prohibit stale-task inference and multi-question checklists', () => {
  const prompt = tinyEdgeSystemPrompt(['tinyedge:read'])
  assert.match(prompt, /new intake unless the user explicitly asks to resume/i)
  assert.match(prompt, /do not inspect or reuse old tasks, notes, traces/i)
  assert.match(prompt, /Do not select a task, model, dataset, workload, capture method, or objective/i)
  assert.match(prompt, /ask exactly one question/i)
  assert.match(prompt, /call ask_choice instead of writing a numbered list/i)
  assert.match(prompt, /hardware interface or capture source is missing, ask for that first/i)
  assert.match(prompt, /Never present a multi-part intake checklist/i)
  assert.match(prompt, /Never choose an existing task merely because its title looks similar/i)
  assert.match(prompt, /only the displayed items can be selected in this preview/i)
})

test('Pi discovers exact run IDs before status, results, and completed-run comparison', async () => {
  const capture = {}
  const calls = []
  const mcpClient = {
    listTools: async () => [
      { name: 'list_runs', description: 'List benchmark runs', inputSchema: { type: 'object' } },
      { name: 'get_job_status', description: 'Get run status', inputSchema: { type: 'object' } },
      { name: 'get_benchmark_results', description: 'Get run results', inputSchema: { type: 'object' } },
      { name: 'compare_runs', description: 'Compare benchmark runs', inputSchema: { type: 'object' } },
      { name: 'get_experiment', description: 'Get experiment', inputSchema: { type: 'object' } },
      { name: 'run_benchmark', description: 'Must not be exposed', inputSchema: { type: 'object' } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args })
      if (name === 'list_runs') {
        return {
          structuredContent: {
            runs: [
              { id: 'run-reference', status: 'completed' },
              { id: 'run-candidate', status: 'completed' },
              { id: 'run-active', status: 'running' },
            ],
            access_token: 'must-not-leak',
          },
        }
      }
      if (name === 'get_job_status') {
        return { structuredContent: { run: { id: args.runId, status: 'completed' } } }
      }
      if (name === 'get_benchmark_results') {
        return { structuredContent: { run: { id: args.runId, metrics: { latencyP95Ms: 12 } } } }
      }
      if (name === 'compare_runs') {
        return { structuredContent: { verdict: 'pass', referenceRunId: args.referenceRunId } }
      }
      return { structuredContent: { experiment: { id: args.experimentId } } }
    },
  }
  const created = await createTinyEdgePiSession({
    config: { configDir: 'C:\\tinyedge-test' },
    mcpClient,
    cwd: 'C:\\work',
    sdk: fakeSdk(capture),
    secretStore: createMemorySecretStore(),
  })
  const tools = new Map(capture.agent.customTools.map((tool) => [tool.name, tool]))

  assert.deepEqual(created.tools, [
    'list_runs',
    'get_job_status',
    'get_benchmark_results',
    'compare_runs',
    'get_experiment',
  ])
  assert.equal(tools.has('run_benchmark'), false)
  assert.match(tools.get('compare_runs').description, /Call list_runs first/)
  await assert.rejects(
    tools.get('compare_runs').execute('compare-before-list', {
      referenceRunId: 'run-reference',
      candidateRunId: 'run-candidate',
    }),
    /Call list_runs first/,
  )

  const listed = await tools.get('list_runs').execute('list-one', {})
  assert.doesNotMatch(listed.content[0].text, /must-not-leak/)
  assert.deepEqual(JSON.parse(listed.content[0].text), {
    runs: [
      { id: 'run-reference', status: 'completed' },
      { id: 'run-candidate', status: 'completed' },
      { id: 'run-active', status: 'running' },
    ],
    total: 3,
    truncated: false,
  })
  await assert.rejects(
    tools.get('get_benchmark_results').execute('invented-result', { runId: 'invented-run' }),
    /exact run ID/,
  )
  await tools.get('get_job_status').execute('status-one', { runId: 'run-reference' })
  await tools.get('get_benchmark_results').execute('results-one', { runId: 'run-candidate' })
  await tools.get('compare_runs').execute('compare-one', {
    referenceRunId: 'run-reference',
    candidateRunId: 'run-candidate',
  })
  await assert.rejects(
    tools.get('compare_runs').execute('compare-active', {
      referenceRunId: 'run-reference',
      candidateRunId: 'run-active',
    }),
    /not completed/,
  )
  await tools.get('get_experiment').execute('experiment-one', { experimentId: 'experiment-from-user' })

  assert.deepEqual(calls.map((call) => call.name), [
    'list_runs',
    'get_job_status',
    'get_benchmark_results',
    'compare_runs',
    'get_experiment',
  ])
})

test('write and run tools require explicit scopes and preserve the browser approval boundary', async () => {
  assert.equal(toolsForScopes(['tinyedge:read']).includes('run_benchmark'), false)
  assert.equal(toolsForScopes(['tinyedge:read', 'tinyedge:write']).includes('bind_model'), true)
  assert.equal(toolsForScopes(['tinyedge:read', 'tinyedge:run']).includes('run_benchmark'), true)

  const capture = {}
  const calls = []
  const mcpClient = {
    listTools: async () => [
      { name: 'list_tasks', inputSchema: { type: 'object' } },
      { name: 'run_benchmark', inputSchema: { type: 'object' } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args })
      if (name === 'list_tasks') return { structuredContent: { tasks: [{ id: 'task-exact' }] } }
      return {
        structuredContent: {
          status: 'approval_required',
          approval: { id: 'approval-exact', confirmationUrl: 'https://tinyedge.ai/approvals/approval-exact' },
        },
      }
    },
  }
  await createTinyEdgePiSession({
    config: { configDir: 'C:\\tinyedge-test' },
    mcpClient,
    cwd: 'C:\\work',
    sdk: fakeSdk(capture),
    secretStore: createMemorySecretStore(),
    grantedScopes: ['tinyedge:read', 'tinyedge:run'],
  })
  const tools = new Map(capture.agent.customTools.map((tool) => [tool.name, tool]))
  assert.equal(tools.get('run_benchmark').renderCall, undefined)
  assert.equal(tools.get('run_benchmark').renderResult, undefined)
  await assert.rejects(
    tools.get('run_benchmark').execute('run-before-list', { taskId: 'task-exact', idempotencyKey: 'one' }),
    /Call list_tasks first/,
  )
  await tools.get('list_tasks').execute('list', {})
  const result = await tools.get('run_benchmark').execute('run', {
    taskId: 'task-exact', idempotencyKey: 'one',
  })
  assert.match(result.content[0].text, /approval_required/)
  assert.match(result.content[0].text, /confirmationUrl/)
  assert.deepEqual(calls.map(({ name }) => name), ['list_tasks', 'run_benchmark'])
})

test('chat command requires read scope and runs a one-shot prompt through the isolated session', async () => {
  const writes = []
  let disposed = false
  let prompted
  const session = {
    listener: null,
    subscribe(listener) { this.listener = listener; return () => { this.listener = null } },
    async prompt(value, options) {
      prompted = { value, options }
      this.listener({
        type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'list_devices', args: {},
      })
      this.listener({
        type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'list_devices', result: {}, isError: false,
      })
      this.listener({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'TinyEdge answer' },
      })
    },
    dispose() { disposed = true },
  }
  const result = await chatCommand({
    config: { mcpUrl: 'https://tinyedge.ai/api/mcp', configDir: 'C:\\tinyedge-test' },
    tokenStore: {
      summary: async () => ({ connected: true, scope: ['tinyedge:read'] }),
      load: async () => ({
        accessToken: 'secret',
        resource: 'https://tinyedge.ai/api/mcp',
      }),
      save: async () => {},
    },
    prompt: 'List my devices',
    requestedModel: 'openai/gpt-test',
    createSession: async ({ requestedModel }) => {
      assert.equal(requestedModel, 'openai/gpt-test')
      return { session, model: requestedModel, tools: TINYEDGE_CHAT_TOOL_ALLOWLIST }
    },
    io: { log() {}, write: (value) => writes.push(value) },
  })
  assert.equal(prompted.value, 'List my devices')
  assert.equal(prompted.options.expandPromptTemplates, false)
  assert.equal(disposed, true)
  assert.match(writes.join(''), /TinyEdge answer/)
  assert.match(writes.join(''), /↳ list_devices/)
  assert.match(writes.join(''), /✓ list_devices/)
  assert.equal(result.model, 'openai/gpt-test')
})

test('chat command refuses a token without TinyEdge read scope', async () => {
  await assert.rejects(chatCommand({
    config: {},
    tokenStore: { summary: async () => ({ connected: true, scope: ['tinyedge:run'] }) },
    prompt: 'List devices',
  }), /grant read access/)
})
