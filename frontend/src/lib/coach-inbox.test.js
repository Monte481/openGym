import { describe, it, expect } from 'vitest'
import { todaysBrief, latestBrief, swapChoices, dayPlanChange, applyDayPlanChange, sleepParts } from './coach-inbox.js'

const TODAY = '2026-11-03'
const routines = [
  { id: 'cc_push', name: 'Push' }, { id: 'cc_pull', name: 'Pull' }, { id: 'cc_legs_b', name: 'Legs B' },
  { id: 'cc_legs_b_pr', name: 'Legs B: deadlift PR' }, { id: 'own', name: 'Arms' },
]
const SINCE = Date.parse('2026-11-02T06:00:00')
const S = (over = {}) => ({
  routines, workouts: [], dayPlan: {},
  queue: { ids: ['cc_push', 'cc_pull', 'cc_legs_b_pr'], since: SINCE, startsOn: '2026-11-02', label: 'Coach' },
  ...over,
})
const prBrief = { id: 'm1', date: TODAY, title: 'PR day', body: '…', plan: { routineId: 'cc_legs_b_pr', altRoutineId: 'cc_legs_b', pr: true } }

describe('which brief', () => {
  it('today\'s is the newest dated today; latest is the newest of all', () => {
    const inbox = { messages: [{ id: 'a', date: TODAY }, { id: 'b', date: TODAY }, { id: 'c', date: '2026-11-04' }] }
    expect(todaysBrief(inbox, TODAY).id).toBe('b')
    expect(todaysBrief(inbox, '2026-11-01')).toBe(null)
    expect(latestBrief(inbox).id).toBe('c')
    expect(latestBrief({})).toBe(null)
  })
})

describe('swap choices', () => {
  it('are the coach week\'s sessions still to do, without today\'s', () => {
    const done = { id: 'w', d: '2026-11-02', start: SINCE + 3600000, routineIds: ['cc_push'], routineId: 'cc_push', name: 'Push' }
    expect(swapChoices(S({ workouts: [done] }), TODAY, 'cc_pull')).toEqual([{ id: 'cc_legs_b_pr', name: 'Legs B: deadlift PR' }])
  })
  it('are every other routine without a coach week', () => {
    expect(swapChoices(S({ queue: null }), TODAY, 'cc_push').map(r => r.id)).toEqual(['cc_pull', 'cc_legs_b', 'cc_legs_b_pr', 'own'])
  })
})

describe('what an answer does to today', () => {
  it('only "not training" is a rest day', () => {
    expect(dayPlanChange(S(), TODAY, 'rest')).toEqual({ set: 'rest' })
    for (const a of ['planned', 'swap', 'skip_pr', 'own']) expect(dayPlanChange(S(), TODAY, a, { brief: prBrief, swapTo: 'cc_pull' })).not.toEqual({ set: 'rest' })
  })
  it('skipping the PR pins the regular session, and only on a PR day', () => {
    expect(dayPlanChange(S(), TODAY, 'skip_pr', { brief: prBrief })).toEqual({ set: 'cc_legs_b' })
    expect(dayPlanChange(S(), TODAY, 'skip_pr', { brief: { ...prBrief, plan: { routineId: 'cc_push' } } })).toBe(null)
    expect(dayPlanChange(S(), TODAY, 'skip_pr', { brief: { ...prBrief, date: '2026-11-02' } })).toBe(null)
    expect(dayPlanChange(S(), TODAY, 'skip_pr', { brief: { ...prBrief, plan: { ...prBrief.plan, altRoutineId: 'gone' } } })).toBe(null)
  })
  it('a swap pins the routine picked, if it exists', () => {
    expect(dayPlanChange(S(), TODAY, 'swap', { swapTo: 'own' })).toEqual({ set: 'own' })
    expect(dayPlanChange(S(), TODAY, 'swap', { swapTo: 'nope' })).toBe(null)
  })
  it('going back to the plan undoes a rest day or a swap', () => {
    const rested = S({ dayPlan: { [TODAY]: 'rest' } })
    expect(dayPlanChange(rested, TODAY, 'planned', { brief: prBrief })).toEqual({ set: 'cc_legs_b_pr' })
    expect(dayPlanChange(rested, TODAY, 'planned')).toEqual({ clear: true })
    expect(dayPlanChange(S(), TODAY, 'planned')).toBe(null)
  })
  it('an own workout pins nothing and undoes a rest day', () => {
    expect(dayPlanChange(S(), TODAY, 'own')).toBe(null)
    expect(dayPlanChange(S({ dayPlan: { [TODAY]: 'rest' } }), TODAY, 'own')).toEqual({ clear: true })
  })
  it('applies to a draft', () => {
    const s = { dayPlan: { [TODAY]: 'rest' } }
    applyDayPlanChange(s, TODAY, { set: 'cc_pull' })
    expect(s.dayPlan[TODAY]).toBe('cc_pull')
    applyDayPlanChange(s, TODAY, { clear: true })
    expect(TODAY in s.dayPlan).toBe(false)
    const bare = {}
    applyDayPlanChange(bare, TODAY, { set: 'rest' })
    expect(bare.dayPlan).toEqual({ [TODAY]: 'rest' })
  })
})

describe('sleep', () => {
  it('splits minutes into hours and minutes', () => {
    expect(sleepParts({ asleepMin: 435 })).toEqual({ h: 7, min: 15 })
    expect(sleepParts({ quality: 'good' })).toBe(null)
  })
})
