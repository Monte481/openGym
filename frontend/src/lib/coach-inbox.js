// The Home card's side of the coach inbox (api/coach-inbox.js): which brief is today's, what the
// athlete can swap to, and what each check-in answer does to today's plan.
//
// The answers, and the one thing each changes on the device, so the day sheet, the reminder and
// the week strip agree with what was answered without waiting for the coach's next run:
//
//   planned  train the brief's routine         → pin it to today (or clear a rest day set earlier)
//   swap     another session today            → pin the chosen one; the coach week keeps the rest
//   skip_pr  the PR day's regular session     → pin the brief's altRoutineId
//   own      train something of your own      → nothing pinned; a rest day set earlier is undone
//   rest     no training                      → today becomes a rest override
//
// Only `rest` is a day off. Declining the plan is not, and the coach reads the difference from
// the check-in the next morning.
import { queueView } from './queue.js'

export const ANSWERS = ['planned', 'swap', 'skip_pr', 'own', 'rest']
export const SORENESS = ['none', 'some', 'lots']
export const SLEEP_QUALITY = ['good', 'ok', 'poor']

const exists = (S, id) => typeof id === 'string' && (S.routines || []).some(r => r.id === id)

/** The newest message dated `today`, else null. The coach sends one brief a morning. */
export function todaysBrief(inbox, today) {
  const msgs = Array.isArray(inbox?.messages) ? inbox.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.date === today) return msgs[i]
  return null
}

/** The newest message of all, for a card that shows the last brief on a day without one. */
export function latestBrief(inbox) {
  const msgs = Array.isArray(inbox?.messages) ? inbox.messages : []
  return msgs.at(-1) || null
}

/**
 * What "Swap session" offers: the coach week's sessions still to do, minus the one already
 * planned for today. With no coach week, every routine but that one.
 */
export function swapChoices(S, today, plannedId) {
  const view = queueView(S, today)
  if (view) return view.items.filter(i => i.state !== 'done' && i.id !== plannedId).map(i => ({ id: i.id, name: i.name }))
  return (S.routines || []).filter(r => r.id !== plannedId).map(r => ({ id: r.id, name: r.name }))
}

/**
 * The change an answer makes to `S.dayPlan[today]`: `{ set: value }`, `{ clear: true }`, or
 * null for no change. `swapTo` is the routine picked for a swap.
 */
export function dayPlanChange(S, today, answer, { brief = null, swapTo = null } = {}) {
  const cur = S.dayPlan?.[today]
  const plan = brief?.date === today ? brief.plan : null
  switch (answer) {
    case 'rest': return cur === 'rest' ? null : { set: 'rest' }
    case 'swap': return exists(S, swapTo) && cur !== swapTo ? { set: swapTo } : null
    case 'skip_pr': return plan?.pr && exists(S, plan.altRoutineId) && cur !== plan.altRoutineId ? { set: plan.altRoutineId } : null
    case 'planned':
      if (exists(S, plan?.routineId)) return cur === plan.routineId ? null : { set: plan.routineId }
      return cur !== undefined ? { clear: true } : null
    case 'own': return cur === 'rest' ? { clear: true } : null
    default: return null
  }
}

/** Applies a dayPlanChange to a draft state (the store's update callback). */
export function applyDayPlanChange(s, today, change) {
  if (!change) return
  if (!s.dayPlan || typeof s.dayPlan !== 'object') s.dayPlan = {}
  if (change.clear) delete s.dayPlan[today]
  else s.dayPlan[today] = change.set
}

/** "7 h 15 min" parts of a night, or null when only a quality word was given. */
export function sleepParts(sleep) {
  const m = sleep?.asleepMin
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return null
  return { h: Math.floor(m / 60), min: Math.round(m % 60) }
}
