import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASK_CHOICE_CUSTOM_OPTION,
  ASK_CHOICE_TOOL,
  createAskChoiceTool,
  normalizeAskChoiceOptions,
  normalizeAskChoiceQuestion,
} from '../src/harness/ask-choice.js'

function parsed(result) {
  return JSON.parse(result.content[0].text)
}

test('ask_choice normalizes the question and distinct options', () => {
  assert.equal(
    normalizeAskChoiceQuestion('  What is your Basler camera capture source?  '),
    'What is your Basler camera capture source?',
  )
  assert.deepEqual(
    normalizeAskChoiceOptions([
      '1. USB3 on each device',
      '2) GigE (network camera)',
      'USB3 on each device',
      'Type a different answer',
      'CSI/other (type your exact interface)',
    ]),
    [
      'USB3 on each device',
      'GigE (network camera)',
      'CSI/other (type your exact interface)',
    ],
  )
  assert.throws(() => normalizeAskChoiceQuestion('   '), /requires a question/)
  assert.throws(() => normalizeAskChoiceOptions(['only one']), /two to six/)
})

test('ask_choice opens the selector and returns the chosen answer', async () => {
  const calls = []
  const tool = createAskChoiceTool()
  assert.equal(tool.name, ASK_CHOICE_TOOL)
  const result = await tool.execute('choice-1', {
    question: 'What is your Basler camera capture source?',
    options: ['USB3 on each device', 'GigE (network camera)', 'CSI/other'],
  }, undefined, undefined, {
    ui: {
      async select(title, options) {
        calls.push({ title, options })
        return 'USB3 on each device'
      },
    },
  })

  assert.deepEqual(calls, [{
    title: 'What is your Basler camera capture source?',
    options: [
      'USB3 on each device',
      'GigE (network camera)',
      'CSI/other',
      ASK_CHOICE_CUSTOM_OPTION,
    ],
  }])
  assert.deepEqual(parsed(result), {
    question: 'What is your Basler camera capture source?',
    selected: 'USB3 on each device',
    custom: false,
  })
  assert.equal(result.details.displaySummary, 'Answer selected')
})

test('ask_choice can collect a typed answer after the custom option', async () => {
  const tool = createAskChoiceTool()
  const result = await tool.execute('choice-2', {
    question: 'What is your Basler camera capture source?',
    options: ['USB3 on each device', 'GigE (network camera)'],
  }, undefined, undefined, {
    ui: {
      async select() { return ASK_CHOICE_CUSTOM_OPTION },
      async input(title, placeholder) {
        assert.equal(title, 'What is your Basler camera capture source?')
        assert.equal(placeholder, 'Type your answer')
        return '  MIPI CSI-2  '
      },
    },
  })

  assert.deepEqual(parsed(result), {
    question: 'What is your Basler camera capture source?',
    selected: 'MIPI CSI-2',
    custom: true,
  })
})

test('ask_choice does not invent an answer when the selector is cancelled or missing', async () => {
  const tool = createAskChoiceTool()
  const cancelled = await tool.execute('choice-3', {
    question: 'Which device should we use?',
    options: ['Jetson AGX Thor', 'Jetson Orin Nano'],
  }, undefined, undefined, {
    ui: { async select() { return undefined } },
  })
  assert.equal(parsed(cancelled).cancelled, true)
  assert.equal(parsed(cancelled).selected, undefined)

  const unavailable = await tool.execute('choice-4', {
    question: 'Which device should we use?',
    options: ['Jetson AGX Thor', 'Jetson Orin Nano'],
  }, undefined, undefined, {})
  assert.equal(parsed(unavailable).cancelled, true)
  assert.match(parsed(unavailable).reason, /Interactive choice UI is unavailable/)
})
