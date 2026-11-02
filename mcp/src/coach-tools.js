/* The coach's tools: what a scheduled coach (an LLM run each morning) needs beyond reading the
   history. It plans a session as a routine of its own, sets the order of the week, pins a session
   to a date, keeps its notes between runs, reads the athlete's check-in and sends the brief.

   Every write goes through the openGym server as log_workout's does (api-client.js), so a phone
   that syncs in between is merged, not overwritten:
     - routines, the coach week (S.queue) and day pins (S.dayPlan) are part of the profile: read
       with GET /api/data, changed, and PUT back with the revision read, retrying on 409. The
       server stamps what changed (api/sync-stamps.js, "an API client"), so every device keeps it.
     - notes, check-ins and messages live in the coach inbox (api/coach-inbox.js), beside the
       profile, and have routes of their own.

   The coach may only change routines it made. Their ids start with "cc"; anything the athlete
   built is read-only here, so a plan edited by hand is never overwritten by the next run. */
import crypto from 'node:crypto'
import { z } from 'zod'
import { isoDate, withCustomsIndexed } from './tools.js'
import { localUid, invalidate } from './state.js'
import { apiConfig, apiFetch } from './api-client.js'
import { resolveExercise } from '../../frontend/src/lib/log-workout.js'

const MAX_ATTEMPTS = 3
const COACH_PREFIX = 'cc'
const ROUTINE_ID = /^[A-Za-z0-9_-]{1,40}$/
export const MAX_SETS = 10
// Routine icons a coach is likely to want; the full set lives in frontend glyphs.js, which pulls in
// React components and so cannot load here.
const ICONS = ['barbell', 'dumbbell', 'figureStrength', 'legs', 'arm', 'abs', 'pullup', 'kettlebell', 'flame', 'bolt', 'trophy', 'stretch']
const localIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}
const isCoachId = id => typeof id === 'string' && id.startsWith(COACH_PREFIX)

/** The profile the token is for, checked against the one this server reads, as log_workout does. */
async function whoAmI(cfg, opts) {
  const me = await apiFetch(cfg, '/api/me', opts)
  const uid = me.body?.user?.id
  if (typeof uid !== 'string' || !uid) throw fail('EAPI', 'the openGym server did not say which profile OPENGYM_TOKEN belongs to (GET /api/me); nothing was changed')
  const local = localUid()
  if (local && local !== uid) {
    console.error(`[opengym-mcp] OPENGYM_TOKEN is for profile ${uid}, this server reads ${local}`)
    throw fail('EPROFILE', 'OPENGYM_TOKEN belongs to another profile than the one this server reads: pair again from the right profile, or set OPENGYM_UID to match')
  }
  return uid
}

/**
 * Read the profile, let `change(S)` edit a copy, and save it. `change` returns
 * { result } to save, { result, unchanged: true } when there is nothing to write, or
 * { problems } to stop with nothing written. On a 409 it runs again on the server's copy.
 */
export async function editProfile(change, { env = process.env, fetchImpl, dryRun = false, what = 'change' } = {}) {
  const cfg = apiConfig(env)
  const opts = fetchImpl ? { fetchImpl } : {}
  await whoAmI(cfg, opts)
  let got = await apiFetch(cfg, '/api/data', opts)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const doc = got.body?.state
    if (!doc || typeof doc !== 'object') throw fail('ENOSTATE', 'this profile has no synced data on the server yet: open openGym and sign in on a device once, then try again')
    // The document exactly as sent, plus the change: a default filled in here would be stamped
    // as an edit made now and land on every device.
    const S = structuredClone(doc)
    const out = change(S)
    if (out.problems) return { saved: false, problems: out.problems, next: 'Nothing was saved. Fix these and call again.' }
    if (dryRun) return { saved: false, dry_run: true, ...out.result }
    if (out.unchanged) return { saved: false, unchanged: true, ...out.result }
    const put = await apiFetch(cfg, '/api/data', { ...opts, method: 'PUT', body: { state: S, baseRev: got.body.rev ?? 0, ...(typeof doc._wid === 'string' ? { baseWid: doc._wid } : {}) } })
    if (put.status !== 409) {
      invalidate()
      console.error(`[opengym-mcp] ${what} saved, rev ${put.body?.rev ?? '?'}`)
      return { saved: true, ...out.result, revision: put.body?.rev ?? null }
    }
    if (!put.body?.state || typeof put.body.state !== 'object' || typeof put.body.rev !== 'number') {
      throw fail('EAPI', 'the openGym server answered 409 without the current profile; nothing was saved')
    }
    got = { status: 200, body: { state: put.body.state, rev: put.body.rev } }
  }
  throw fail('ECONFLICT', `the profile kept changing on the server (${MAX_ATTEMPTS} attempts); nothing was saved, try again in a moment`)
}

/** One coach-inbox call, as the signed-in profile. */
async function inbox(path, { method = 'GET', body, env = process.env, fetchImpl } = {}) {
  const cfg = apiConfig(env)
  const opts = fetchImpl ? { fetchImpl } : {}
  await whoAmI(cfg, opts)
  const r = await apiFetch(cfg, path, { ...opts, method, body })
  if (r.status === 409) throw fail('EAPI', 'the openGym server refused the inbox write (409)')
  return r.body
}

/* ------------------------------------------------------------------ routines */

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * One planned exercise as the slot a routine stores. Plain "sets × reps @ weight", or a top set
 * and back-off sets, which become pyramid sets with a weight each (the app never progresses a
 * pyramid exercise on its own, so the coach's numbers are the ones the athlete sees).
 */
export function slotOf(S, ex) {
  const hit = resolveExercise(S, ex.exercise)
  if (hit.problem) return { problem: { exercise: ex.exercise, problem: hit.problem, ...(hit.candidates ? { candidates: hit.candidates } : {}) } }
  const slot = { id: hit.id, mode: 'reps' }
  if (ex.top_set) {
    const back = ex.back_off ? Array.from({ length: ex.back_off.sets }, () => ex.back_off) : []
    const rows = [ex.top_set, ...back]
    if (rows.length > MAX_SETS) return { problem: { exercise: ex.exercise, problem: `at most ${MAX_SETS} sets` } }
    slot.sets = rows.length
    slot.reps = ex.top_set.reps
    slot.weight = num(ex.top_set.weight) ?? 0
    slot.pyramid = rows.map(r => r.reps)
    slot.pyramidWeight = rows.map(r => num(r.weight) ?? 0)
  } else {
    if (!ex.sets || !ex.reps) return { problem: { exercise: ex.exercise, problem: 'give sets and reps, or a top_set' } }
    slot.sets = ex.sets
    slot.reps = ex.reps
    slot.weight = num(ex.weight) ?? 0
    if (ex.reps_min != null) slot.repsMin = ex.reps_min
    if (ex.reps_max != null) slot.repsMax = ex.reps_max
  }
  if (ex.rest_sec != null) slot.restSec = ex.rest_sec
  if (ex.warmup_sets) slot.warmupSets = ex.warmup_sets
  const note = String(ex.note ?? '').trim().slice(0, 280)
  if (note) slot.note = note
  return { slot, name: hit.name }
}

const exerciseSchema = z.object({
  exercise: z.string().min(1).max(120).describe('Exercise name ("barbell back squat") or an exercise id. A name matching several entries comes back as a problem with candidates.'),
  sets: z.number().int().min(1).max(MAX_SETS).optional().describe('Working sets, for plain sets × reps.'),
  reps: z.number().int().min(1).max(100).optional().describe('Reps per set, for plain sets × reps (the top of the range when reps_min is given).'),
  reps_min: z.number().int().min(1).max(100).optional().describe('Bottom of a rep range, e.g. 10 for 10-12.'),
  reps_max: z.number().int().min(1).max(100).optional(),
  weight: z.number().min(0).max(2000).optional().describe('Load in the profile\'s unit (see unit in the reply). 0 or omitted for bodyweight.'),
  top_set: z.object({ reps: z.number().int().min(1).max(100), weight: z.number().min(0).max(2000) }).optional()
    .describe('A heavy top set, for the main lifts. Use with back_off instead of sets/reps.'),
  back_off: z.object({ sets: z.number().int().min(1).max(MAX_SETS - 1), reps: z.number().int().min(1).max(100), weight: z.number().min(0).max(2000) }).optional()
    .describe('Back-off sets after the top set, all at one weight.'),
  rest_sec: z.number().int().min(0).max(900).optional(),
  warmup_sets: z.number().int().min(0).max(5).optional().describe('Warm-up sets the app adds before the working sets.'),
  note: z.string().max(280).optional().describe('Cue shown with the exercise, e.g. "RPE 8, 2 reps left".'),
})

export const upsertRoutine = {
  name: 'upsert_routine',
  description: [
    'Create or replace one of the coach\'s own routines (a planned session) with exact exercises, sets, reps and weights.',
    'Weights are in the profile\'s unit. For a main lift give top_set plus back_off; for accessories sets, reps (and reps_min for a range) and weight.',
    'Pass routine_id to replace a routine made earlier by this tool (ids start with "cc"); omit it to make a new one, and the reply gives its id.',
    'Routines the athlete made are never changed. Coach routines open with these exact numbers: the app does not progress them on its own.',
    'Use dry_run first if any exercise name may be ambiguous.',
  ].join(' '),
  schema: {
    routine_id: z.string().regex(ROUTINE_ID).optional().describe('An existing coach routine to replace (starts with "cc"). Omit to create.'),
    name: z.string().min(1).max(60).describe('e.g. "Legs A: squat" or "Legs B: deadlift PR".'),
    icon: z.enum(ICONS).optional().describe('Icon for the routine; defaults to barbell.'),
    exercises: z.array(exerciseSchema).min(1).max(20),
    dry_run: z.boolean().optional(),
  },
  handler: async (p, ctx = {}) => {
    if (p.routine_id && !isCoachId(p.routine_id)) throw fail('EOWNED', `"${p.routine_id}" is not a coach routine: only routines whose id starts with "${COACH_PREFIX}" can be changed. Omit routine_id to make a new one.`)
    const id = p.routine_id || COACH_PREFIX + crypto.randomBytes(5).toString('hex')
    return editProfile(S => {
      const slots = [], problems = []
      withCustomsIndexed(S, () => {
        for (const ex of p.exercises) {
          const r = slotOf(S, ex)
          if (r.problem) problems.push(r.problem)
          else slots.push(r)
        }
      })
      if (problems.length) return { problems }
      S.routines = Array.isArray(S.routines) ? S.routines : []
      const prev = S.routines.find(r => r.id === id)
      const routine = { ...(prev || {}), id, name: p.name, emoji: p.icon || prev?.emoji || 'barbell', ex: slots.map(s => s.slot) }
      if (prev) S.routines = S.routines.map(r => (r.id === id ? routine : r))
      else S.routines.push(routine)
      return {
        result: {
          routine_id: id, created: !prev, name: p.name, unit: S.unit === 'lb' ? 'lb' : 'kg',
          exercises: slots.map(s => ({ id: s.slot.id, name: s.name, sets: s.slot.sets, ...(s.slot.pyramid ? { reps: s.slot.pyramid, weights: s.slot.pyramidWeight } : { reps: s.slot.reps, weight: s.slot.weight }) })),
        },
      }
    }, { ...ctx, dryRun: p.dry_run === true, what: `upsert_routine ${id}` })
  },
}

export const deleteRoutine = {
  name: 'delete_coach_routine',
  description: 'Delete one of the coach\'s own routines (id starts with "cc") that is no longer needed. It is also taken out of the coach week. The athlete\'s routines cannot be deleted here.',
  schema: { routine_id: z.string().regex(ROUTINE_ID) },
  handler: async (p, ctx = {}) => {
    if (!isCoachId(p.routine_id)) throw fail('EOWNED', `"${p.routine_id}" is not a coach routine`)
    return editProfile(S => {
      if (!(S.routines || []).some(r => r.id === p.routine_id)) return { result: { routine_id: p.routine_id, deleted: false }, unchanged: true }
      S.routines = S.routines.filter(r => r.id !== p.routine_id)
      if (S.queue && Array.isArray(S.queue.ids)) S.queue = { ...S.queue, ids: S.queue.ids.filter(x => x !== p.routine_id) }
      // The app records a removal so other devices drop it too (sync-merge.js); the server does
      // the same for a writer that does not stamp, so nothing else is needed here.
      return { result: { routine_id: p.routine_id, deleted: true } }
    }, { ...ctx, what: `delete_coach_routine ${p.routine_id}` })
  },
}

/* ------------------------------------------------------------------ the week */

export const setCoachWeek = {
  name: 'set_coach_week',
  description: [
    'Set the coach week: the sessions to do, in order, on whatever days the athlete trains (no weekdays).',
    'The first one not yet done is "today\'s session" in the app; a session counts as done once a finished workout on that routine is logged.',
    'Setting a new week starts a new pass: sessions done before now count for the old one.',
    'Pass an empty list to end the coach week and go back to the athlete\'s weekday plan.',
  ].join(' '),
  schema: {
    routine_ids: z.array(z.string().regex(ROUTINE_ID)).max(14).describe('Routine ids in order, usually coach routines from upsert_routine.'),
    label: z.string().max(40).optional().describe('Shown above the sessions in the app, e.g. "Week 3".'),
    starts_on: isoDate().optional().describe('The date the week becomes active; defaults to today.'),
    dry_run: z.boolean().optional(),
  },
  handler: async (p, ctx = {}) => {
    const now = Date.now()
    return editProfile(S => {
      const known = new Set((S.routines || []).map(r => r.id))
      const missing = p.routine_ids.filter(id => !known.has(id))
      if (missing.length) return { problems: missing.map(id => ({ routine_id: id, problem: 'no routine with this id' })) }
      if (!p.routine_ids.length) {
        S.queue = null
        return { result: { coach_week: null } }
      }
      S.queue = { ids: [...p.routine_ids], since: now, startsOn: p.starts_on || localIso(new Date(now)), label: p.label || 'Coach' }
      const names = Object.fromEntries((S.routines || []).map(r => [r.id, r.name]))
      return { result: { coach_week: { label: S.queue.label, starts_on: S.queue.startsOn, sessions: p.routine_ids.map(id => ({ routine_id: id, name: names[id] })) } } }
    }, { ...ctx, dryRun: p.dry_run === true, what: 'set_coach_week' })
  },
}

export const pinDay = {
  name: 'pin_day',
  description: [
    'Put a session on a date, or make the date a rest day, or clear what was set for it.',
    'Use it to land a PR session after a rest day, or to keep a heavy day away from it.',
    'A pinned coach-week session is that day\'s session; on other days the week skips it until it is done.',
    'This is the same per-date override the athlete sets in the app, so it replaces theirs for that date: check get_week_plan first.',
  ].join(' '),
  schema: {
    date: isoDate().describe('YYYY-MM-DD, today or later.'),
    routine_id: z.string().regex(ROUTINE_ID).optional().describe('The routine for that date. Omit with rest or clear.'),
    rest: z.boolean().optional().describe('Make the date a rest day.'),
    clear: z.boolean().optional().describe('Remove whatever was set for the date.'),
  },
  handler: async (p, ctx = {}) => {
    const picked = [p.routine_id ? 1 : 0, p.rest ? 1 : 0, p.clear ? 1 : 0].reduce((a, b) => a + b)
    if (picked !== 1) throw fail('EINPUT', 'give exactly one of routine_id, rest: true or clear: true')
    if (p.date < localIso(new Date())) throw fail('EINPUT', 'that date is in the past')
    return editProfile(S => {
      if (p.routine_id && !(S.routines || []).some(r => r.id === p.routine_id)) return { problems: [{ routine_id: p.routine_id, problem: 'no routine with this id' }] }
      S.dayPlan = S.dayPlan && typeof S.dayPlan === 'object' ? S.dayPlan : {}
      const before = S.dayPlan[p.date] ?? null
      if (p.clear) delete S.dayPlan[p.date]
      else S.dayPlan[p.date] = p.rest ? 'rest' : p.routine_id
      const after = S.dayPlan[p.date] ?? null
      return { result: { date: p.date, before, after }, unchanged: before === after }
    }, { ...ctx, what: `pin_day ${p.date}` })
  },
}

/* ------------------------------------------------------------------ the inbox */

export const getCoachInbox = {
  name: 'get_coach_inbox',
  description: [
    'Read the coach inbox: your notes from earlier runs, the messages you sent, and the athlete\'s daily check-ins keyed by date.',
    'A check-in has answer (planned | swap | skip_pr | own | rest; only rest means no training), soreness (none | some | lots), request (a line for you), and sleep (asleepMin, quality, deepMin, remMin, hrv, restingHr; source health is the Apple Watch).',
    '`today` is the athlete\'s own date. Call this first on every run.',
  ].join(' '),
  schema: { days: z.number().int().min(1).max(120).optional().describe('How many days of check-ins, default 14.') },
  handler: async (p, ctx = {}) => inbox(`/api/coach-inbox?days=${p.days || 14}`, ctx),
}

export const saveCoachNotes = {
  name: 'save_coach_notes',
  description: 'Replace your notes: the program state the next run needs (rotation position, current top-set weights, last PR attempt per lift, deload counter, milestones hit, the athlete profile and goals). Any JSON up to 64 KB. The athlete never sees it. Save the whole object each time; it is not merged.',
  schema: { notes: z.record(z.string(), z.any()).describe('The whole notes object.') },
  handler: async (p, ctx = {}) => inbox('/api/coach-inbox/notes', { ...ctx, method: 'PUT', body: { notes: p.notes } }),
}

export const sendMessage = {
  name: 'send_message',
  description: [
    'Send the athlete a message: the morning brief. It is stored, shown on the app\'s Home card with the day\'s check-in, and its title and first line are pushed to their phone.',
    'Keep it short and readable on a phone. Put the most important line first: it is the notification.',
    'Pass routine_id for the session planned today; on a PR day also pr: true and alt_routine_id (the same session at normal weights) so the athlete can skip the attempt with one tap.',
    '`pushed: false` in the reply means no device has notifications on: say so in the next brief. At most 6 a day.',
  ].join(' '),
  schema: {
    title: z.string().min(1).max(120).describe('e.g. "Legs A: squat 145 x 3 today".'),
    body: z.string().min(1).max(4000),
    routine_id: z.string().regex(ROUTINE_ID).optional(),
    alt_routine_id: z.string().regex(ROUTINE_ID).optional(),
    pr: z.boolean().optional(),
    dry_run: z.boolean().optional(),
  },
  handler: async (p, ctx = {}) => {
    if ((p.pr || p.alt_routine_id) && !p.routine_id) throw fail('EINPUT', 'a PR day or an alternative needs routine_id too')
    const plan = p.routine_id ? { routineId: p.routine_id, ...(p.alt_routine_id ? { altRoutineId: p.alt_routine_id } : {}), pr: p.pr === true } : undefined
    if (p.dry_run) return { sent: false, dry_run: true, would_send: { title: p.title, body: p.body, ...(plan ? { plan } : {}) } }
    const r = await inbox('/api/coach-inbox/messages', { ...ctx, method: 'POST', body: { title: p.title, body: p.body, ...(plan ? { plan } : {}) } })
    return { sent: true, pushed: r?.pushed === true, message_id: r?.message?.id ?? null }
  },
}

export const COACH_TOOLS = [getCoachInbox, saveCoachNotes, sendMessage, upsertRoutine, deleteRoutine, setCoachWeek, pinDay]
