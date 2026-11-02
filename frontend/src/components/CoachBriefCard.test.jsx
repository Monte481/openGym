// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The Home card for an outside coach: nothing until a brief exists, then the brief and the day's
   check-in. Each answer is posted to the inbox and changes today's plan on the device the way
   lib/coach-inbox.js says; "Not training today" is the only one that makes it a rest day. The
   store and the API are stand-ins. */
const TODAY = '2026-11-03'
const mocks = vi.hoisted(() => {
  const state = { toast: vi.fn(), inbox: null, posts: [], drafts: [] }
  state.S = {
    routines: [{ id: 'cc_legs_b_pr', name: 'Legs B: PR' }, { id: 'cc_legs_b', name: 'Legs B' }, { id: 'cc_push', name: 'Push' }],
    workouts: [], dayPlan: {}, week: {},
    queue: { ids: ['cc_legs_b_pr', 'cc_push'], since: 0, startsOn: '2026-11-02', label: 'Coach' },
  }
  state.update = fn => { const d = structuredClone(state.S); fn(d); state.drafts.push(d); state.S = d }
  state.api = vi.fn(async (path, opts) => {
    if (path === '/api/coach-inbox') return state.inbox
    const body = JSON.parse(opts.body)
    state.posts.push({ path, body })
    const { date, ...patch } = body
    return { ok: true, date, checkin: { ...(state.inbox.checkins[date] || {}), ...patch } }
  })
  state.snapshot = () => ({ S: state.S, user: { id: 'u1', name: 'Timon' }, update: state.update })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a) })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({ api: (...a) => mocks.api(...a) }))
vi.mock('../lib/demo.js', () => ({ DEMO: false }))

const { default: CoachBriefCard } = await import('./CoachBriefCard.jsx')

let host, root
const render = async () => { await act(async () => { root.render(<CoachBriefCard />) }); await act(async () => {}) }
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent === text)
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => {}) }
const click = async text => { await act(async () => { button(text).click() }); await flush() }
const brief = (over = {}) => ({ id: 'm1', date: TODAY, title: 'Deadlift PR day', body: 'Work up to 210.\nEat rice at 17:00.', plan: { routineId: 'cc_legs_b_pr', altRoutineId: 'cc_legs_b', pr: true }, ...over })

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  mocks.posts.length = 0; mocks.drafts.length = 0; mocks.S.dayPlan = {}
  mocks.inbox = { today: TODAY, messages: [brief()], checkins: {}, notes: null, sleepToken: false }
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('CoachBriefCard', () => {
  it('shows nothing until a coach has sent a brief', async () => {
    mocks.inbox = { today: TODAY, messages: [], checkins: {} }
    await render()
    expect(host.textContent).toBe('')
  })

  it('shows today\'s brief and its answers, with Skip the PR only on a PR day', async () => {
    await render()
    expect(host.textContent).toContain('Deadlift PR day')
    expect(host.textContent).toContain('Eat rice at 17:00.')
    expect(button('Skip the PR')).toBeTruthy()
    mocks.inbox.messages = [brief({ plan: { routineId: 'cc_push' } })]
    act(() => root.unmount()); root = createRoot(host)
    await render()
    expect(button('Skip the PR')).toBeUndefined()
  })

  it('skipping the PR posts the answer and pins the regular session', async () => {
    await render()
    await click('Skip the PR')
    expect(mocks.posts).toEqual([{ path: '/api/coach-inbox/checkin', body: { date: TODAY, answer: 'skip_pr' } }])
    expect(mocks.S.dayPlan[TODAY]).toBe('cc_legs_b')
    expect(button('Skip the PR').getAttribute('aria-pressed')).toBe('true')
  })

  it('a swap asks which session, then pins it; declining is not a rest day', async () => {
    await render()
    await click('Swap session')
    expect(mocks.posts).toEqual([])
    await click('Push')
    expect(mocks.posts.at(-1).body).toEqual({ date: TODAY, answer: 'swap' })
    expect(mocks.S.dayPlan[TODAY]).toBe('cc_push')
    await click('My own workout')
    expect(mocks.S.dayPlan[TODAY]).toBe('cc_push')
    await click('Not training today')
    expect(mocks.S.dayPlan[TODAY]).toBe('rest')
  })

  it('soreness, sleep and a note are posted on their own', async () => {
    mocks.inbox.checkins[TODAY] = { sleep: { source: 'health', asleepMin: 412 } }
    await render()
    expect(host.textContent).toContain('Slept 6 h 52 min')
    await click('A bit sore')
    await click('Slept badly')
    const input = host.querySelector('input')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, 'Heavy deadlift Friday please')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Send')
    expect(mocks.posts.map(p => p.body)).toEqual([
      { date: TODAY, soreness: 'some' },
      { date: TODAY, sleep: { quality: 'poor' } },
      { date: TODAY, request: 'Heavy deadlift Friday please' },
    ])
    expect(mocks.drafts).toEqual([], 'none of these touch the plan')
  })

  it('an old brief is shown without the check-in', async () => {
    mocks.inbox.messages = [brief({ date: '2026-11-01', title: 'Push day' })]
    await render()
    expect(host.textContent).toContain('Last brief from your coach')
    expect(button('As planned')).toBeUndefined()
  })
})
