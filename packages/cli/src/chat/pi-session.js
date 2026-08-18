import path from 'node:path'

import { redactSecrets } from '../auth/redact.js'
import { ASK_CHOICE_TOOL } from '../harness/ask-choice.js'
import { READ_SCOPE, RUN_SCOPE, WRITE_SCOPE } from '../config.js'
import { createPiCredentialStore } from './pi-credential-store.js'

const READ_TOOLS = Object.freeze([
  'list_devices',
  'list_tasks',
  'get_benchmark_brief',
  'list_models',
  'list_datasets',
  'list_runs',
  'get_job_status',
  'get_benchmark_results',
  'compare_runs',
  'get_experiment',
  'list_capture_sessions',
  'list_activity',
  'plan_capture',
])

const WRITE_TOOLS = Object.freeze([
  'create_benchmark_task',
  'bind_model',
  'bind_dataset',
  'build_benchmark_plan',
  'update_benchmark_requirements',
  'rename_benchmark_task',
])

const RUN_TOOLS = Object.freeze([
  'plan_experiment',
  'run_benchmark',
  'start_capture',
  'cancel_capture',
  'cancel_experiment',
  'delete_benchmark_task',
])

export const TINYEDGE_CHAT_TOOL_ALLOWLIST = Object.freeze([
  ASK_CHOICE_TOOL, ...READ_TOOLS, ...WRITE_TOOLS, ...RUN_TOOLS,
])

export function toolsForScopes(scopes = []) {
  const granted = new Set(scopes)
  return Object.freeze([
    ...(granted.has(READ_SCOPE) ? READ_TOOLS : []),
    ...(granted.has(WRITE_SCOPE) ? WRITE_TOOLS : []),
    ...(granted.has(RUN_SCOPE) ? RUN_TOOLS : []),
  ])
}

const MAX_TOOL_RESULT_BYTES = 64 * 1024
const MAX_DISCOVERY_ITEMS = 25

const RUN_ID_TOOLS = new Set([
  'get_job_status',
  'get_benchmark_results',
  'compare_runs',
])

const TASK_ID_TOOLS = new Set([
  'get_benchmark_brief', 'list_capture_sessions', 'bind_model', 'bind_dataset',
  'plan_capture', 'build_benchmark_plan', 'update_benchmark_requirements',
  'rename_benchmark_task', 'run_benchmark', 'start_capture', 'cancel_capture',
  'delete_benchmark_task',
])

const MODEL_ID_TOOLS = new Map([
  ['bind_model', 'modelId'],
  ['plan_experiment', 'sourceModelId'],
])

const DATASET_ID_TOOLS = new Map([
  ['bind_dataset', 'datasetId'],
  ['plan_experiment', 'datasetId'],
])

const TOOL_GUIDANCE = Object.freeze({
  list_devices: 'For a new benchmark intake, call this at most once to verify the user-named target without exposing device IDs.',
  list_runs: 'Call this before any run status, result, or comparison tool. Use only the exact run IDs and statuses it returns.',
  get_job_status: 'Use only a runId returned by list_runs in this chat. Never guess or invent a run ID.',
  get_benchmark_results: 'Use only a runId returned by list_runs in this chat. Never guess or invent a run ID.',
  compare_runs: 'Call list_runs first, use two exact returned IDs, and compare only runs whose status is completed.',
  get_experiment: 'Use only an exact experimentId supplied by the user or returned by a TinyEdge tool. Never guess or invent an ID.',
  list_tasks: 'Call this only when the user explicitly asks to list, inspect, or resume existing work. Never call it during a new benchmark intake. Use only exact task IDs returned in this chat.',
  list_models: 'Do not call during a new benchmark intake. Discover models only after the user has defined the workload and objective.',
  list_datasets: 'Do not call during a new benchmark intake. Discover datasets only after the user has defined the workload and evaluation evidence.',
  run_benchmark: 'This is consequential. First build and explain the immutable plan and cost ceiling. An initial call requests a browser approval; never claim it ran until the approved retry succeeds.',
  plan_experiment: 'This queues physical work despite its name. Explain lanes and cost first; an initial call requests explicit browser approval.',
  start_capture: 'Explain the capture source, duration, destination, and privacy boundary before requesting browser approval.',
  cancel_capture: 'Use the exact capture session and approval returned by TinyEdge. Never invent IDs.',
  cancel_experiment: 'Use an exact experiment ID. Explain what pending work will be canceled before requesting approval.',
  delete_benchmark_task: 'Deletion requires explicit browser approval. Never delete merely to resolve an error.',
})

const TOOL_DISPLAY = Object.freeze({
  list_devices: ['Checking your TinyEdge devices', 'devices', 'registered device'],
  list_tasks: ['Checking saved benchmark tasks', 'tasks', 'saved benchmark task'],
  list_models: ['Checking available models', 'models', 'available model'],
  list_datasets: ['Checking available datasets', 'datasets', 'available dataset'],
  list_runs: ['Checking benchmark runs', 'runs', 'benchmark run'],
  list_capture_sessions: ['Checking capture sessions', 'captureSessions', 'capture session'],
  list_activity: ['Checking recent TinyEdge activity', 'activity', 'activity item'],
})

const DISCOVERY_FIELDS = Object.freeze({
  list_devices: Object.freeze([
    'device', 'model', 'deviceType', 'type', 'kind', 'available', 'lastSeen', 'lastSeenAt',
  ]),
  // Discovery deliberately excludes requirements, notes, bound artifacts, and
  // assistant state. The user must explicitly choose an existing task before
  // the assistant reads its benchmark brief.
  list_tasks: Object.freeze(['id', 'title', 'updatedAt']),
  list_models: Object.freeze(['id', 'name', 'filename', 'format', 'framework', 'createdAt']),
  list_datasets: Object.freeze(['id', 'name', 'filename', 'format', 'createdAt']),
  list_runs: Object.freeze(['id', 'name', 'status', 'taskId', 'createdAt', 'completedAt']),
  list_capture_sessions: Object.freeze([
    'id', 'taskId', 'state', 'method', 'durationSeconds', 'captureDeviceId',
    'replaySourceDeviceId', 'createdAt',
  ]),
  list_activity: Object.freeze(['id', 'type', 'operation', 'status', 'summary', 'createdAt']),
})

export function tinyEdgeSystemPrompt(scopes) {
  const granted = new Set(scopes)
  const mode = granted.has(RUN_SCOPE) ? 'read, configure, and run approved work'
    : granted.has(WRITE_SCOPE) ? 'read and configure benchmark plans'
      : 'read account evidence'
  return `You are the TinyEdge terminal assistant. You may ${mode}.
Answer questions about the signed-in user's TinyEdge account using only the available TinyEdge tools.
Never request, reveal, repeat, or infer credentials. Keep answers concise and evidence based.
Never guess or invent a task, run, experiment, model, dataset, or device ID.
Before acting on an existing task, call list_tasks and use an exact returned ID. A task ID returned by create_benchmark_task in this chat is already trusted.
Before reading run status, run results, or comparing runs, call list_runs in this chat and use only exact IDs it returned.
Compare runs only after their returned status is completed. If list_runs is unavailable or no exact ID is available, explain that instead of calling an ID-based tool.
Treat a request to benchmark, test, or evaluate a setup as a new intake unless the user explicitly asks to resume an existing TinyEdge task.
For a new intake, you may call list_devices once to verify the target. Do not call list_tasks, list_models, or list_datasets, and do not inspect or reuse old tasks, notes, traces, artifact bindings, or capture settings.
Do not select a task, model, dataset, workload, capture method, or objective from account history or from an assumption. An artifact bound to an old task is not a recommendation for this request.
After the device check, give at most two short context sentences and ask exactly one question. When the user should choose among known options, call ask_choice instead of writing a numbered list. The selector already includes a type-a-different-answer option. Never present a multi-part intake checklist.
For a camera or sensor request, if the hardware interface or capture source is missing, ask for that first and never infer it from account history.
Do not expose internal IDs, raw tool output, stored state names such as "intake", or internal notes unless the user asks or an ID is required to disambiguate two human-readable choices.
If the user explicitly asks to resume existing work, call list_tasks, present only human-readable task titles, and ask the user to choose before reading any task brief. Never choose an existing task merely because its title looks similar.
If a discovery response is truncated, explain that only the displayed items can be selected in this preview. Never invent or act on an omitted ID.
For every consequential tool: explain the exact plan and cost first; treat approval_required as a request for the human to confirm in the browser; never bypass, fabricate, or reuse an approval for different input; report success only after TinyEdge returns a successful result.
If a requested action needs a scope you do not have, tell the user which explicit login flag grants it.`
}

function renderToolResult(value) {
  const serialized = JSON.stringify(value, null, 2) || 'null'
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_TOOL_RESULT_BYTES) return serialized
  return `${serialized.slice(0, MAX_TOOL_RESULT_BYTES)}\n[TRUNCATED]`
}

function parsedToolPayload(value) {
  if (value?.structuredContent && typeof value.structuredContent === 'object') {
    return value.structuredContent
  }
  for (const entry of value?.content || []) {
    if (entry?.type !== 'text' || typeof entry.text !== 'string') continue
    try {
      const parsed = JSON.parse(entry.text)
      if (parsed?.structuredContent && typeof parsed.structuredContent === 'object') {
        return parsed.structuredContent
      }
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Human-readable tool output is still rendered, but cannot establish trusted IDs.
    }
  }
  return value && typeof value === 'object' ? value : null
}

function compactRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(fields
    .filter((field) => value[field] !== undefined)
    .map((field) => [field, value[field]]))
}

export function toolPayloadForModel(name, value) {
  const payload = redactSecrets(parsedToolPayload(value))
  const display = TOOL_DISPLAY[name]
  const fields = DISCOVERY_FIELDS[name]
  if (!display || !fields) return payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`TinyEdge ${name} returned an invalid discovery response`)
  }

  const collectionKey = display[1]
  if (!Array.isArray(payload[collectionKey])) {
    throw new Error(`TinyEdge ${name} returned an invalid discovery response`)
  }
  const items = payload[collectionKey]
  const total = Number.isInteger(payload.total) && payload.total >= items.length
    ? payload.total
    : items.length
  const visibleItems = items.slice(0, MAX_DISCOVERY_ITEMS)
    .map((item) => compactRecord(item, fields))
  const truncated = Boolean(payload.truncated) || total > visibleItems.length
  return {
    [collectionKey]: visibleItems,
    total,
    truncated,
    ...(truncated ? {
      selectionNotice: total > visibleItems.length
        ? `Only the first ${visibleItems.length} of ${total} items can be selected in this preview.`
        : 'Only the displayed items can be selected in this preview; additional items were omitted.',
    } : {}),
  }
}

export function toolResultContentForModel(name, value) {
  if (value?.isError) {
    const message = (value.content || [])
      .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
      .map((entry) => entry.text)
      .join('\n') || 'TinyEdge request failed'
    return renderToolResult({ error: redactSecrets(message) })
  }
  return renderToolResult(toolPayloadForModel(name, value))
}

function readableToolName(name) {
  return String(name || 'TinyEdge request')
    .split('_')
    .filter(Boolean)
    .join(' ')
    .replace(/^./, (letter) => letter.toUpperCase())
}

export function toolDisplaySummary(name, value) {
  if (value?.isError) return 'TinyEdge request failed'
  const display = TOOL_DISPLAY[name]
  if (!display) return 'TinyEdge response received'
  const payload = parsedToolPayload(value)
  const visibleCount = Array.isArray(payload?.[display[1]]) ? payload[display[1]].length : 0
  const count = Number.isInteger(payload?.total) && payload.total >= visibleCount
    ? payload.total
    : visibleCount
  const base = `Found ${count} ${display[2]}${count === 1 ? '' : 's'}`
  if (!payload?.truncated) return base
  return count > visibleCount
    ? `${base} · showing ${visibleCount}; ${count - visibleCount} omitted`
    : `${base} · showing a limited selection`
}

function compactTextComponent(value, theme, color = 'toolOutput', bold = false) {
  return {
    render(width) {
      const rawLines = String(value).split('\n')
      const fallbackWidth = Math.max(...rawLines.map((line) => line.length), 1)
      const available = Math.max(1, Number.isFinite(width) ? Math.floor(width) : fallbackWidth)
      return rawLines.map((raw) => {
        const clipped = raw.length <= available
          ? raw
          : `${raw.slice(0, Math.max(0, available - 1))}…`
        const formatted = bold && typeof theme?.bold === 'function' ? theme.bold(clipped) : clipped
        return typeof theme?.fg === 'function' ? theme.fg(color, formatted) : formatted
      })
    },
    invalidate() {},
  }
}

function toolRenderers(name) {
  const callLabel = TOOL_DISPLAY[name]?.[0] || readableToolName(name)
  return {
    renderCall(_args, theme) {
      return compactTextComponent(callLabel, theme, 'toolTitle', true)
    },
    renderResult(result, options, theme, context) {
      const summary = context?.isError
        ? 'TinyEdge request failed'
        : result?.details?.displaySummary || 'TinyEdge data loaded'
      if (!options?.expanded || context?.isError) {
        return compactTextComponent(summary, theme, context?.isError ? 'error' : 'muted')
      }
      const modelText = toolResultContentForModel(name, { content: result?.content || [] })
      const lines = modelText.split('\n')
      const visible = lines.slice(0, 12)
      const remaining = Math.max(0, lines.length - visible.length)
      const diagnostic = remaining
        ? `${visible.join('\n')}\n… ${remaining} more compact lines`
        : visible.join('\n')
      return compactTextComponent(`${summary}\n${diagnostic}`, theme, 'muted')
    },
  }
}

function ingestRunState(runState, value) {
  const payload = parsedToolPayload(value)
  const runs = Array.isArray(payload?.runs)
    ? payload.runs
    : payload?.run && typeof payload.run === 'object'
      ? [payload.run]
      : []
  for (const run of runs) {
    const id = run?.id || run?.runId
    if (typeof id !== 'string' || !id) continue
    runState.set(id, typeof run.status === 'string' ? run.status : null)
  }
}

function ingestTaskState(taskState, value) {
  const payload = parsedToolPayload(value)
  const tasks = Array.isArray(payload?.tasks)
    ? payload.tasks
    : payload?.task && typeof payload.task === 'object' ? [payload.task] : []
  for (const task of tasks) {
    if (typeof task?.id === 'string' && task.id) taskState.add(task.id)
  }
}

function ingestIdentityState(identityState, value, collectionKey) {
  const payload = parsedToolPayload(value)
  const items = Array.isArray(payload?.[collectionKey]) ? payload[collectionKey] : []
  for (const item of items) {
    if (typeof item?.id === 'string' && item.id) identityState.add(item.id)
  }
}

function ingestCaptureState(captureState, value, fallbackTaskId) {
  const payload = parsedToolPayload(value)
  const sessions = Array.isArray(payload?.captureSessions)
    ? payload.captureSessions
    : payload?.captureSession && typeof payload.captureSession === 'object'
      ? [payload.captureSession]
      : []
  for (const session of sessions) {
    if (typeof session?.id !== 'string' || !session.id) continue
    const taskId = session.taskId || session.studyId || fallbackTaskId
    if (typeof taskId === 'string' && taskId) captureState.set(session.id, taskId)
  }
}

function requireKnownRun(runState, runId) {
  if (typeof runId !== 'string' || !runState.has(runId)) {
    throw new Error('Call list_runs first and use an exact run ID returned by TinyEdge')
  }
}

function validateRunToolCall(name, params, runState) {
  if (!RUN_ID_TOOLS.has(name)) return
  if (name === 'compare_runs') {
    requireKnownRun(runState, params?.referenceRunId)
    requireKnownRun(runState, params?.candidateRunId)
    for (const runId of [params.referenceRunId, params.candidateRunId]) {
      if (runState.get(runId) !== 'completed') {
        throw new Error(`Run ${runId} is not completed and cannot be compared`)
      }
    }
    return
  }
  requireKnownRun(runState, params?.runId)
}

function requireKnownIdentity(identityState, value, discoveryTool, label) {
  if (typeof value !== 'string' || !identityState.has(value)) {
    throw new Error(`Call ${discoveryTool} first and use an exact ${label} ID returned by TinyEdge`)
  }
}

function validateIdentityToolCall(name, params, { modelState, datasetState, captureState }) {
  const modelField = MODEL_ID_TOOLS.get(name)
  if (modelField) {
    requireKnownIdentity(modelState, params?.[modelField], 'list_models', 'model')
  }

  const datasetField = DATASET_ID_TOOLS.get(name)
  if (datasetField && params?.[datasetField] != null) {
    requireKnownIdentity(datasetState, params[datasetField], 'list_datasets', 'dataset')
  }

  if (name === 'cancel_capture') {
    requireKnownIdentity(captureState, params?.sessionId, 'list_capture_sessions', 'capture session')
    if (captureState.get(params.sessionId) !== params?.taskId) {
      throw new Error('Use the exact task and capture session pair returned by TinyEdge')
    }
  }
}

export async function loadOfficialPiSdk() {
  try {
    return await import('@tinyedge/pi-runtime')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('TinyEdge Pi runtime is not installed. Reinstall the exact TinyEdge package before using `tinyedge chat`.')
    }
    throw error
  }
}

function modelIdentity(model) {
  return `${model.provider}/${model.id}`
}

export async function selectPiModel(modelRuntime, requestedModel) {
  const available = await modelRuntime.getAvailable()
  if (!available.length) {
    throw new Error('No authenticated Pi model is available. Configure a model provider in Pi first.')
  }
  if (!requestedModel) return available[0]

  const selected = available.find((model) => modelIdentity(model) === requestedModel)
  if (!selected) {
    throw new Error(`Pi model is not available or authenticated: ${requestedModel}`)
  }
  return selected
}

export function createTinyEdgePiTools({ sdk, mcpClient, advertisedTools, allowedTools = READ_TOOLS }) {
  const advertised = new Map(advertisedTools.map((tool) => [tool.name, tool]))
  const runState = new Map()
  const taskState = new Set()
  const modelState = new Set()
  const datasetState = new Set()
  const captureState = new Map()
  const canDiscoverRuns = advertised.has('list_runs')
  return allowedTools
    .filter((name) => advertised.has(name))
    .filter((name) => canDiscoverRuns || !RUN_ID_TOOLS.has(name))
    .map((name) => {
      const remote = advertised.get(name)
      return sdk.defineTool({
        name,
        label: remote.title || name,
        description: [remote.description || `Call TinyEdge ${name}`, TOOL_GUIDANCE[name]]
          .filter(Boolean)
          .join(' '),
        parameters: remote.inputSchema || { type: 'object', additionalProperties: false },
        execute: async (_toolCallId, params) => {
          validateRunToolCall(name, params, runState)
          if (TASK_ID_TOOLS.has(name) && !taskState.has(params?.taskId)) {
            throw new Error('Call list_tasks first and use an exact task ID returned by TinyEdge')
          }
          validateIdentityToolCall(name, params, { modelState, datasetState, captureState })
          const result = await mcpClient.callTool(name, params)
          const failurePayload = parsedToolPayload(result)
          if (result?.isError || failurePayload?.error) {
            const rawMessage = typeof failurePayload?.error === 'string'
              ? failurePayload.error
              : failurePayload?.error?.message
            const suffix = rawMessage ? `: ${redactSecrets(rawMessage)}` : ''
            throw new Error(`TinyEdge request failed${suffix}`)
          }
          const modelPayload = toolPayloadForModel(name, result)
          if (name === 'list_runs' || name === 'get_job_status') ingestRunState(runState, modelPayload)
          if (name === 'list_tasks' || name === 'create_benchmark_task') ingestTaskState(taskState, modelPayload)
          if (name === 'list_models') ingestIdentityState(modelState, modelPayload, 'models')
          if (name === 'list_datasets') ingestIdentityState(datasetState, modelPayload, 'datasets')
          if (name === 'list_capture_sessions' || name === 'start_capture' || name === 'cancel_capture') {
            ingestCaptureState(captureState, modelPayload, params?.taskId)
          }
          return {
            content: [{ type: 'text', text: renderToolResult(modelPayload) }],
            details: { displaySummary: toolDisplaySummary(name, modelPayload) },
          }
        },
        ...(TOOL_DISPLAY[name] ? toolRenderers(name) : {}),
      })
    })
}

export async function createTinyEdgePiSession({
  config,
  mcpClient,
  cwd = process.cwd(),
  requestedModel,
  grantedScopes = [READ_SCOPE],
  sdk: suppliedSdk,
  secretStore,
}) {
  const sdk = suppliedSdk || await loadOfficialPiSdk()
  const advertisedTools = await mcpClient.listTools()
  const allowedTools = toolsForScopes(grantedScopes)
  const customTools = createTinyEdgePiTools({ sdk, mcpClient, advertisedTools, allowedTools })
  if (!customTools.length) {
    throw new Error('TinyEdge MCP did not advertise any tools allowed by this chat client')
  }

  const agentDir = path.join(config.configDir, 'pi-internal')
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: tinyEdgeSystemPrompt(grantedScopes),
  })
  await resourceLoader.reload()

  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: createPiCredentialStore({ configDir: config.configDir, secretStore }),
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  const model = await selectPiModel(modelRuntime, requestedModel)
  const toolNames = customTools.map((tool) => tool.name)
  const settingsManager = sdk.SettingsManager.inMemory()
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    noTools: 'all',
    tools: toolNames,
    customTools,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    settingsManager,
  })

  return Object.freeze({
    session,
    model: modelIdentity(model),
    tools: Object.freeze([...toolNames]),
  })
}
