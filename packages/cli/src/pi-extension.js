import { createAuthenticatedMcp } from './auth/session.js'
import { createNativeSecretStore } from './auth/secret-store.js'
import { createTokenStore } from './auth/token-store.js'
import {
  createTinyEdgePiTools,
  TINYEDGE_CHAT_TOOL_ALLOWLIST,
  toolDisplaySummary,
  toolResultContentForModel,
  toolsForScopes,
} from './chat/pi-session.js'
import { createConfig, loginScopes, withScopes } from './config.js'
import { loginCommand } from './commands/login.js'
import { logoutCommand } from './commands/logout.js'
import { ASK_CHOICE_TOOL, createAskChoiceTool } from './harness/ask-choice.js'
import { createHarnessHeader, summarizeDeviceInventory } from './harness/header.js'

const NEW_BENCHMARK_INTENT = /\b(?:benchmark(?:ing|ed|s)?|evaluat(?:e|ing|ed|ion)|profil(?:e|ing|ed)|measure(?:ment|ments|d|s|ing)?|test(?:ing|ed|s)?)\b/i
const EXISTING_WORK_INTENT = /\b(?:resume|continue)\b|\b(?:existing|previous|saved)\s+(?:task|benchmark|run|work)\b|\b(?:benchmark\s+)?(?:status|results?|comparison)\b/i
const NEW_INTAKE_TOOL_BLOCK = 'Start this new benchmark by verifying the named device and asking one question. Do not inspect saved work or select artifacts yet.'
const REPEATED_DEVICE_CHECK_BLOCK = 'The device was already checked for this request. Ask the user one concise intake question now.'
const defineTool = (definition) => definition

export function isFreshBenchmarkRequest(value) {
  const prompt = String(value || '')
  return NEW_BENCHMARK_INTENT.test(prompt) && !EXISTING_WORK_INTENT.test(prompt)
}

export function compactTinyEdgeHistory(messages = []) {
  const tinyEdgeTools = new Set(TINYEDGE_CHAT_TOOL_ALLOWLIST)
  return messages.map((message) => {
    if (message?.role !== 'toolResult' || !tinyEdgeTools.has(message.toolName)) return message
    try {
      return {
        ...message,
        content: [{ type: 'text', text: toolResultContentForModel(message.toolName, message) }],
        details: {
          displaySummary: toolDisplaySummary(message.toolName, message),
        },
      }
    } catch {
      return {
        ...message,
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'TinyEdge history entry omitted because its discovery response was invalid',
          }),
        }],
        details: {
          displaySummary: 'Invalid TinyEdge history entry omitted',
        },
        isError: true,
      }
    }
  })
}

function loginFlags(value) {
  const flags = new Set(String(value || '').trim().split(/\s+/).filter(Boolean))
  for (const flag of flags) {
    if (flag !== '--allow-write' && flag !== '--allow-run') {
      throw new Error('Usage: /tinyedge-login [--allow-write] [--allow-run]')
    }
  }
  return {
    allowWrite: flags.has('--allow-write'),
    allowRun: flags.has('--allow-run'),
  }
}

function uiIo(ctx) {
  return {
    log(value) { ctx.ui.notify(String(value), 'info') },
    error(value) { ctx.ui.notify(String(value), 'error') },
  }
}

/**
 * Create the TinyEdge extension for an existing Pi installation. Dependencies
 * are injectable so the package can be verified without credentials/network.
 */
export function createTinyEdgePiExtension({
  env = process.env,
  platform = process.platform,
  createConfigImpl = createConfig,
  createSecretStoreImpl = createNativeSecretStore,
  createTokenStoreImpl = createTokenStore,
  createAuthenticatedMcpImpl = createAuthenticatedMcp,
  createToolsImpl = createTinyEdgePiTools,
  loginImpl = loginCommand,
  logoutImpl = logoutCommand,
  defineToolImpl = defineTool,
  standalone = false,
  autoLogin = false,
  showHeader = false,
} = {}) {
  return function tinyEdgeExtension(pi) {
    const config = createConfigImpl(env, platform)
    const secretStore = createSecretStoreImpl({ configDir: config.configDir, platform })
    const tokenStore = createTokenStoreImpl({ configDir: config.configDir, secretStore })
    const askChoiceTool = createAskChoiceTool(defineToolImpl)
    pi.registerTool(askChoiceTool)
    let registeredTools = []
    let headerContext
    let freshBenchmarkTurn = false
    let freshDeviceCheckStarted = false
    const headerState = {
      connected: false,
      connecting: false,
      deviceGroups: [],
    }

    function renderHeader(ctx = headerContext) {
      if (!showHeader || !ctx || ctx.mode !== 'tui') return
      headerContext = ctx
      ctx.ui.setHeader(createHarnessHeader({
        getState: () => ({ ...headerState, modelConfigured: Boolean(ctx.model) }),
      }))
    }

    function updateHeader(next, ctx) {
      Object.assign(headerState, next)
      renderHeader(ctx)
    }

    async function authenticatedForCurrentScopes() {
      const summary = await tokenStore.summary()
      if (!summary.connected) throw new Error('Run /tinyedge-login first')
      const allowedTools = toolsForScopes(summary.scope)
      const auth = await createAuthenticatedMcpImpl({ config, tokenStore, allowedTools })
      return { ...auth, allowedTools, summary }
    }

    async function refreshDeviceInventory(client, advertisedTools, ctx) {
      if (!advertisedTools.some((tool) => tool.name === 'list_devices')) {
        updateHeader({ deviceGroups: [] }, ctx)
        return []
      }
      try {
        const result = await client.callTool('list_devices', {})
        const deviceGroups = summarizeDeviceInventory(result)
        updateHeader({ deviceGroups }, ctx)
        return deviceGroups
      } catch (error) {
        updateHeader({ deviceGroups: [] }, ctx)
        ctx.ui.notify(`Device inventory unavailable: ${error?.message || String(error)}`, 'warning')
        return []
      }
    }

    async function registerCurrentTools(ctx, announce = true) {
      const { client, allowedTools } = await authenticatedForCurrentScopes()
      const advertisedTools = await client.listTools()
      // Re-register the complete scope set as one generation so task/run ID
      // discovery state is shared by the tools that depend on it.
      const freshClient = {
        async callTool(name, args) {
          const current = await authenticatedForCurrentScopes()
          return current.client.callTool(name, args)
        },
      }
      const tools = createToolsImpl({
        sdk: { defineTool: defineToolImpl },
        mcpClient: freshClient,
        advertisedTools,
        allowedTools,
      })
      for (const tool of tools) pi.registerTool(tool)
      registeredTools = tools.map((tool) => tool.name)
      const active = standalone
        ? [ASK_CHOICE_TOOL, ...registeredTools]
        : [...new Set([...pi.getActiveTools(), ASK_CHOICE_TOOL, ...registeredTools])]
      pi.setActiveTools(active)
      updateHeader({ connected: true, connecting: false }, ctx)
      await refreshDeviceInventory(client, advertisedTools, ctx)
      if (announce) ctx.ui.notify(`TinyEdge connected: ${registeredTools.length} tools available`, 'info')
      return registeredTools
    }

    async function connect(ctx, flags = { allowWrite: false, allowRun: false }) {
      updateHeader({ connecting: true }, ctx)
      const scopedConfig = withScopes(config, loginScopes(flags))
      await loginImpl({ config: scopedConfig, tokenStore, io: uiIo(ctx) })
      return registerCurrentTools(ctx)
    }

    pi.registerCommand('tinyedge-login', {
      description: 'Connect TinyEdge: /tinyedge-login [--allow-write] [--allow-run]',
      handler: async (args, ctx) => {
        try {
          const flags = loginFlags(args)
          await connect(ctx, flags)
        } catch (error) {
          updateHeader({ connecting: false }, ctx)
          ctx.ui.notify(error?.message || String(error), 'error')
        }
      },
    })

    pi.registerCommand('tinyedge-status', {
      description: 'Show the TinyEdge connection and granted scopes',
      handler: async (_args, ctx) => {
        const summary = await tokenStore.summary()
        if (!summary.connected) {
          ctx.ui.notify('TinyEdge is not connected. Run /tinyedge-login.', 'warning')
          return
        }
        ctx.ui.notify(`TinyEdge connected · ${summary.scope.join(', ')} · ${registeredTools.length} tools`, 'info')
      },
    })

    pi.registerCommand('tinyedge-tools', {
      description: 'Show TinyEdge tools enabled for this Pi session',
      handler: async (_args, ctx) => {
        ctx.ui.notify(registeredTools.length ? registeredTools.join('\n') : 'No TinyEdge tools loaded', 'info')
      },
    })

    pi.registerCommand('tinyedge-devices', {
      description: 'Refresh paired TinyEdge devices shown in the Harness header',
      handler: async (_args, ctx) => {
        try {
          await registerCurrentTools(ctx, false)
          const total = headerState.deviceGroups.reduce((sum, group) => sum + group.total, 0)
          ctx.ui.notify(`${total} paired TinyEdge device${total === 1 ? '' : 's'}`, 'info')
        } catch (error) {
          ctx.ui.notify(error?.message || String(error), 'error')
        }
      },
    })

    pi.registerCommand('tinyedge-logout', {
      description: 'Revoke TinyEdge authorization and remove local credentials',
      handler: async (_args, ctx) => {
        await logoutImpl({ tokenStore, io: uiIo(ctx) })
        const previous = new Set(registeredTools)
        pi.setActiveTools([
          ASK_CHOICE_TOOL,
          ...pi.getActiveTools().filter((name) => name === ASK_CHOICE_TOOL || !previous.has(name)),
        ].filter((name, index, names) => names.indexOf(name) === index))
        registeredTools = []
        updateHeader({ connected: false, connecting: false, deviceGroups: [] }, ctx)
        ctx.ui.notify('TinyEdge disconnected. Registered tools now fail closed.', 'info')
      },
    })

    pi.on('before_agent_start', (event) => {
      freshBenchmarkTurn = isFreshBenchmarkRequest(event.prompt)
      freshDeviceCheckStarted = false
    })

    pi.on('context', (event) => ({
      messages: compactTinyEdgeHistory(event.messages),
    }))

    // A low-level agent run can end before Pi retries, compacts, or drains a
    // queued follow-up. Keep the intake boundary until the full request settles.
    pi.on('agent_settled', () => {
      freshBenchmarkTurn = false
      freshDeviceCheckStarted = false
    })

    if (standalone) {
      pi.on('user_bash', () => ({
        result: {
          output: 'Shell access is disabled in TinyEdge Harness.',
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      }))

    }

    pi.on('tool_call', (event) => {
      if (event.toolName === ASK_CHOICE_TOOL) return undefined
      if (freshBenchmarkTurn && event.toolName === 'list_devices'
        && registeredTools.includes(event.toolName)) {
        if (freshDeviceCheckStarted) {
          return { block: true, reason: REPEATED_DEVICE_CHECK_BLOCK }
        }
        freshDeviceCheckStarted = true
        return undefined
      }
      if (freshBenchmarkTurn && registeredTools.includes(event.toolName)
        && event.toolName !== 'list_devices') {
        return { block: true, reason: NEW_INTAKE_TOOL_BLOCK }
      }
      if (!standalone || registeredTools.includes(event.toolName)) return undefined
      return { block: true, reason: 'Only reviewed TinyEdge tools are available in this Harness.' }
    })

    pi.on('session_start', async (_event, ctx) => {
      pi.setActiveTools([...new Set([ASK_CHOICE_TOOL, ...pi.getActiveTools()])])
      renderHeader(ctx)
      try {
        const summary = await tokenStore.summary()
        updateHeader({ connected: summary.connected, connecting: false }, ctx)
        if (summary.connected) await registerCurrentTools(ctx, false)
        else if (autoLogin) {
          ctx.ui.notify('Connect TinyEdge in the browser to load your account and devices.', 'info')
          try {
            await connect(ctx)
          } catch (error) {
            updateHeader({ connected: false, connecting: false }, ctx)
            ctx.ui.notify(`TinyEdge is not connected: ${error?.message || String(error)}. Run /tinyedge-login to try again.`, 'warning')
          }
        } else {
          ctx.ui.notify('TinyEdge is not connected. Run /tinyedge-login.', 'warning')
        }
      } catch (error) {
        updateHeader({ connected: false, connecting: false }, ctx)
        ctx.ui.notify(`TinyEdge tools unavailable: ${error?.message || String(error)}`, 'warning')
      }
      if (!ctx.model) {
        ctx.ui.notify('Choose a model provider with /login to start chatting.', 'warning')
      }
    })
  }
}

export default createTinyEdgePiExtension()
