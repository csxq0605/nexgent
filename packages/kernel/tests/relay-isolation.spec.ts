/** Audit D1, D6, D7 and the collaboration tool scopes: relayed user words, steers by id, a thread without its own copy. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  relayedCoordinatorNote,
  relayedUserNote,
  relayedWordsMessage,
  renderUserWords,
  type Agent,
  type CompactionCheckInput,
  type CompactionResult,
  type ContextService,
  type KernelToolContext,
  type LLMRequest,
  type LLMStreamEvent,
  type MemberWorkdirs,
  type Tool,
} from '../src/index.js'
import { conversation, servicePlugin, textReply, toolCallReply, usage } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

function during(before: () => void, events: LLMStreamEvent[]): (request: LLMRequest) => AsyncIterable<LLMStreamEvent> {
  return async function* () {
    before()
    yield* events
  }
}

const NAMES = ['post_collab', 'read_collab', 'message_peer', 'ask_coordinator', 'read_merged', 'stop_thread', 'start_thread'] as const
function fakeTool(name: string): Tool {
  return { definition: { name, description: name, inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' }, handler: async () => ({ content: name }) }
}
async function toolsOf(agent: Agent, llm: Harness['llm'], reply: number): Promise<string[]> {
  await agent.run('hello')
  return (llm.requests[reply]!.tools ?? []).map(tool => tool.name).filter(name => (NAMES as readonly string[]).includes(name)).sort()
}

describe('relayed user words in a thread', () => {
  it('are recorded as they are after the thread message and sent behind a prefix', async () => {
    harness = await bootHarness({ script: [textReply('ok')] })
    const { app, llm, store } = harness
    const thread = await app.agents.create({ thread: { coordinatorSessionId: 'c', title: 'Part' } })
    await thread.run({ source: 'thread', text: 'Write the part.', relay: ['Use tabs, never spaces.'] })
    expect(store.of(thread.sessionId, 'user.message').map(record => [record.source, record.content])).toEqual([
      ['thread', 'Write the part.'],
      ['relay', 'Use tabs, never spaces.'],
    ])
    expect(conversation(llm.requests[0]!)).toEqual([
      { role: 'user', content: 'Write the part.' },
      { role: 'user', content: relayedWordsMessage('Use tabs, never spaces.') },
    ])
    expect(relayedWordsMessage('x')).toContain("The user's own words (passed on by Nexgent):")
    await thread.close()
  })

  it('stay word for word through a compaction', async () => {
    harness = await bootHarness({ script: [textReply('ok'), textReply('fine')] })
    const { app, llm, store } = harness
    const compactor = {
      shouldCompact: (input: CompactionCheckInput) => input.turn === 2,
      async compact(input: CompactionCheckInput): Promise<CompactionResult> {
        return { summary: 'A part.', keepMessages: 1, compactedMessages: input.messages.length - 1, requestId: 'aux', usage: usage(5, 5), trigger: { inputTokens: 0, threshold: 1 } }
      },
    }
    await app.ctx.plugin(servicePlugin('context', { providers: [], register: () => () => undefined, compactor } satisfies ContextService))
    const thread = await app.agents.create({ thread: { coordinatorSessionId: 'c', title: 'Part' } })
    await thread.run({ source: 'thread', text: 'Write the part.', relay: ['Use tabs, never spaces.'] })
    await thread.run({ source: 'thread', text: 'Go on.' })
    const summary = 'A part.' + renderUserWords([{ turn: 1, text: 'Use tabs, never spaces.' }])
    expect(store.of(thread.sessionId, 'compaction')[0]).toMatchObject({ summary, userWords: { turns: [1] } })
    // Only the coordinator's message text is not "the user's words".
    expect(summary).not.toContain('Write the part.')
    expect(conversation(llm.requests[1]!).at(-1)).toEqual({ role: 'user', content: 'Go on.' })
    await thread.close()
  })

  it('sent with a mid-turn message reach the thread and its working member as the user\'s words', async () => {
    let thread: Agent | undefined
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'work', {}),
        during(() => thread!.steer('Mind the new rule.', { source: 'thread', relay: ['No tabs.'] }), textReply('worked')),
        textReply('worked again'),
        textReply('done'),
      ],
    })
    const { app, llm, store } = harness
    let member: Agent | undefined
    app.ctx.tools.register({
      ...fakeTool('work'),
      handler: async (_input, context) => {
        const ctx = context as KernelToolContext
        member = await app.agents.create({ child: { parentSessionId: ctx.sessionId, member: { name: 'helper', executionForm: 'delegated' } } })
        const result = await member.run('Work.', { signal: context.signal })
        await member.close()
        return { content: result.text }
      },
    })
    thread = await app.agents.create({ thread: { coordinatorSessionId: 'c', title: 'Part' } })
    await thread.run({ source: 'thread', text: 'Start.' })
    expect(store.of(member!.sessionId, 'user.message').filter(record => record.source === 'inject').map(record => record.content)).toEqual([
      relayedCoordinatorNote('Mind the new rule.'), relayedUserNote('No tabs.'),
    ])
    expect(store.of(thread.sessionId, 'user.message').slice(-2).map(record => [record.source, record.content])).toEqual([
      ['thread', 'Mind the new rule.'], ['relay', 'No tabs.'],
    ])
    expect(conversation(llm.requests[3]!).slice(-2)).toEqual([
      { role: 'user', content: 'Mind the new rule.' }, { role: 'user', content: relayedWordsMessage('No tabs.') },
    ])
    await thread.close()
  })
})

describe('messages with the same words (D6)', () => {
  it('are each passed on to a member that starts after them', async () => {
    let root: Agent | undefined
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'pair', {}),
        during(() => { root!.steer('again'); root!.steer('again') }, textReply('x')),
        textReply('m1'),
        textReply('m2'),
        textReply('done'),
      ],
    })
    const { app, store } = harness
    const members: Agent[] = []
    app.ctx.tools.register({
      ...fakeTool('pair'),
      handler: async (_input, context) => {
        const ctx = context as KernelToolContext
        for (const name of ['one', 'two']) {
          const member = await app.agents.create({ child: { parentSessionId: ctx.sessionId, member: { name, executionForm: 'delegated' } } })
          members.push(member)
          await member.run('go', { signal: context.signal })
          await member.close()
        }
        return { content: 'ok' }
      },
    })
    root = await app.agents.create()
    await root.run('start')
    // Both messages reached the member that started after them, although the words are the same; the first member got them live.
    const injected = (member: Agent) => store.of(member.sessionId, 'user.message').filter(record => record.source === 'inject').map(record => record.content)
    expect(injected(members[0]!)).toEqual([relayedUserNote('again'), relayedUserNote('again')])
    expect(injected(members[1]!)).toEqual([relayedUserNote('again'), relayedUserNote('again')])
    await root.close()
  })
})

describe('a thread without its own copy (D7)', () => {
  it('says so and is not isolated', async () => {
    harness = await bootHarness({ script: [textReply('ok')] })
    const { app, store } = harness
    const workdirs: MemberWorkdirs = { open: async () => { throw new Error('no space') } }
    await app.ctx.plugin(servicePlugin('workdirs', workdirs))
    const thread = await app.agents.create({ thread: { coordinatorSessionId: 'c', title: 'Part' } })
    expect(thread.isolated).toBe(false)
    await thread.run({ source: 'thread', text: 'Go.' })
    expect(store.of(thread.sessionId, 'error')).toEqual([expect.objectContaining({ fatal: false })])
    await thread.close()
  })

  it('is isolated with a copy, and for a conversation that is not a thread', async () => {
    harness = await bootHarness({ script: [] })
    const { app, root } = harness
    await app.ctx.plugin(servicePlugin('workdirs', { open: async () => ({ root, refresh: async () => undefined, merge: async () => ({ applied: [], merged: [], conflicts: [] }), close: async () => undefined }) } satisfies MemberWorkdirs))
    const thread = await app.agents.create({ thread: { coordinatorSessionId: 'c', title: 'Part' } })
    const plain = await app.agents.create()
    expect([thread.isolated, plain.isolated]).toEqual([true, true])
    await thread.close()
    await plain.close()
  })
})

describe('collaboration tool scopes', () => {
  async function boot(collaboration?: 'hybrid') {
    harness = await bootHarness({ script: [textReply('a'), textReply('b'), textReply('c'), textReply('d')] })
    if (collaboration !== undefined) {
      mkdirSync(join(harness.root, '.nexgent'), { recursive: true })
      writeFileSync(join(harness.root, '.nexgent', 'config.json'), JSON.stringify({ collaboration }))
    }
    for (const name of NAMES) harness.app.ctx.tools.register(fakeTool(name))
    return harness
  }

  it('give a thread the peer tools, post_collab only in hybrid, and no thread tool', async () => {
    const { app, llm } = await boot()
    const central = await app.agents.create({ thread: { coordinatorSessionId: 'c', title: 'Part' } })
    expect(await toolsOf(central, llm, 0)).toEqual(['ask_coordinator', 'message_peer', 'read_collab', 'read_merged'])
    await central.close()
  })

  it('give a thread post_collab in hybrid', async () => {
    const { app, llm } = await boot('hybrid')
    const thread = await app.agents.create({ thread: { coordinatorSessionId: 'c', title: 'Part' } })
    expect(await toolsOf(thread, llm, 0)).toEqual(['ask_coordinator', 'message_peer', 'post_collab', 'read_collab', 'read_merged'])
    await thread.close()
  })

  it('give the coordinator post_collab, read_collab and stop_thread, and any other session or member none', async () => {
    const { app, llm } = await boot()
    const coordinator = await app.agents.create({ coordinator: true })
    expect(await toolsOf(coordinator, llm, 0)).toEqual(['post_collab', 'read_collab', 'start_thread', 'stop_thread'])
    const plain = await app.agents.create()
    expect((await toolsOf(plain, llm, 1)).filter(name => !name.endsWith('_thread'))).toEqual([])
    const thread = await app.agents.create({ thread: { coordinatorSessionId: 'c', title: 'Part' } })
    const member = await app.agents.create({ child: { parentSessionId: thread.sessionId, member: { name: 'helper', executionForm: 'delegated' } } })
    expect((await toolsOf(member, llm, 2)).filter(name => !name.endsWith('_thread'))).toEqual([])
    await member.close()
    await thread.close()
    await plain.close()
    await coordinator.close()
  })
})
