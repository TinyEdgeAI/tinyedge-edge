export const ASK_CHOICE_TOOL = 'ask_choice'
export const ASK_CHOICE_CUSTOM_OPTION = 'Type a different answer'

const MAX_QUESTION_CHARS = 240
const MAX_OPTION_CHARS = 80
const MIN_OPTIONS = 2
const MAX_OPTIONS = 6

function jsonResult(payload, displaySummary) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: { displaySummary },
  }
}

function trimText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

function stripChoicePrefix(value) {
  return String(value || '').replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim()
}

export function normalizeAskChoiceQuestion(value) {
  const question = trimText(value, MAX_QUESTION_CHARS)
  if (!question) throw new Error('ask_choice requires a question')
  return question
}

export function normalizeAskChoiceOptions(value) {
  if (!Array.isArray(value)) throw new Error('ask_choice requires two to six options')
  const seen = new Set()
  const options = []
  for (const entry of value) {
    const option = trimText(stripChoicePrefix(entry), MAX_OPTION_CHARS)
    if (!option) continue
    const key = option.toLowerCase()
    if (seen.has(key) || key === ASK_CHOICE_CUSTOM_OPTION.toLowerCase()) continue
    seen.add(key)
    options.push(option)
    if (options.length === MAX_OPTIONS) break
  }
  if (options.length < MIN_OPTIONS) {
    throw new Error('ask_choice requires two to six distinct options')
  }
  return options
}

function dialogOptions(signal) {
  return signal ? { signal } : undefined
}

export function createAskChoiceTool(defineTool = (definition) => definition) {
  return defineTool({
    name: ASK_CHOICE_TOOL,
    label: 'Ask',
    description:
      'Ask the user one multiple-choice question in the Harness selector. Use this instead of writing numbered lists. The selector always includes a type-a-different-answer option.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'options'],
      properties: {
        question: {
          type: 'string',
          description: 'The one question to ask.',
        },
        options: {
          type: 'array',
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          items: { type: 'string' },
          description: 'Two to six short, mutually exclusive answers.',
        },
      },
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const question = normalizeAskChoiceQuestion(params?.question)
      const options = normalizeAskChoiceOptions(params?.options)
      const labels = [...options, ASK_CHOICE_CUSTOM_OPTION]

      if (typeof ctx?.ui?.select !== 'function') {
        return jsonResult({
          cancelled: true,
          question,
          options,
          reason: 'Interactive choice UI is unavailable. Ask the question in text and wait for a typed answer.',
        }, 'Choice UI unavailable')
      }

      const selected = await ctx.ui.select(question, labels, dialogOptions(signal))
      if (selected == null) {
        return jsonResult({
          cancelled: true,
          question,
          options,
        }, 'Choice cancelled')
      }

      if (String(selected).trim().toLowerCase() === ASK_CHOICE_CUSTOM_OPTION.toLowerCase()) {
        if (typeof ctx.ui.input !== 'function') {
          return jsonResult({
            cancelled: true,
            question,
            options,
            reason: 'Custom input is unavailable. Ask the user to type an answer.',
          }, 'Custom input unavailable')
        }
        const typed = await ctx.ui.input(question, 'Type your answer', dialogOptions(signal))
        const answer = String(typed || '').trim()
        if (!answer) {
          return jsonResult({ cancelled: true, question, options }, 'Choice cancelled')
        }
        return jsonResult({
          question,
          selected: answer,
          custom: true,
        }, 'Custom answer selected')
      }

      return jsonResult({
        question,
        selected: String(selected).trim(),
        custom: false,
      }, 'Answer selected')
    },
  })
}
