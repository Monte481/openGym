// The coach's tools against a stand-in api: a node:http server answering /api/me, /api/data and
// the coach-inbox routes the way api/server.js does, recording what it is sent. The real server's
// side of the inbox is api/test/server-coach-inbox.test.js.
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { upsertRoutine, deleteRoutine, setCoachWeek, pinDay, getCoachInbox, saveCoachNotes, sendMessage, slotOf, COACH_TOOLS } from '../src/coach-tools.js'
import { _seedStateForTests } from '../src/state.js'

const TOKEN = 'tok.secret-value'
const UID = 'test-uid'   // the profile _seedStateForTests reads
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
const tomorrow = () => { const d = new Date(Date.now() + 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }

const BASE = () => ({
  unit: 'kg',
  routines: [{ id: 'mine', name: 'My arms', emoji: 'arm', ex: [{ id: '0025', sets: 3, reps: 10, weight: 60, mode: 'reps' }] }],
  workouts: [], dayPlan: {}, week: {}, customEx: [],
})

function stubApi(doc, script = {}) {
  const s = { doc: structuredClone(doc), rev: 3, puts: [], inbox: [], script }
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'not signed in' })
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : undefined
    if (req.url === '/api/me') return send(200, { user: { id: UID, name: 'Timon' } })
    if (req.url === '/api/data' && req.method === 'GET') return send(200, { state: s.doc, rev: s.rev })
    if (req.url === '/api/data' && req.method === 'PUT') {
      s.puts.push(body)
      // A phone writes in between the first time, when the script says so.
      if (script.conflictOnce && s.puts.length === 1) {
        s.doc = { ...s.doc, workouts: [{ id: 'phone', d: today() }] }
        s.rev++
        return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      }
      if (body.baseRev !== s.rev) return send(409, { error: 'conflict', rev: s.rev, state: s.doc })
      s.doc = body.state
      s.rev++
      return send(200, { ok: true, rev: s.rev })
    }
    if (req.url.startsWith('/api/coach-inbox')) {
      s.inbox.push({ method: req.method, url: req.url, body })
      if (req.method === 'GET') return send(200, { today: today(), notes: { rotation: 2 }, notesAt: 1, messages: [], checkins: { [today()]: { answer: 'skip_pr', soreness: 'some' } }, sleepToken: false })
      if (req.url === '/api/coach-inbox/messages') return send(200, { ok: true, message: { id: 'm1', ...body }, pushed: script.pushed ?? true })
      return send(200, { ok: true })
    }
    send(404, { error: 'not found' })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    s.server = server
    s.env = { OPENGYM_URL: `http://127.0.0.1:${server.address().port}`, OPENGYM_TOKEN: TOKEN }
    resolve(s)
  }))
}

let api
beforeEach(() => { _seedStateForTests(BASE()) })
afterEach(() => api?.server.close())

describe('upsert_routine', () => {
  test('a main lift as a top set and back-offs, accessories as sets × reps, in the profile\'s unit', async () => {
    api = await stubApi(BASE())
    const r = await upsertRoutine.handler({
      name: 'Legs A: squat', icon: 'legs',
      exercises: [
        { exercise: 'squat', top_set: { reps: 3, weight: 145 }, back_off: { sets: 3, reps: 5, weight: 125 }, rest_sec: 240, warmup_sets: 3, note: 'RPE 8' },
        { exercise: 'standing calf raise', sets: 4, reps: 10, weight: 80 },
      ],
    }, { env: api.env })
    expect(r.saved).toBe(true)
    expect(r.routine_id).toMatch(/^cc[0-9a-f]{10}$/)
    expect(r.unit).toBe('kg')
    const saved = api.doc.routines.find(x => x.id === r.routine_id)
    expect(saved).toEqual({
      id: r.routine_id, name: 'Legs A: squat', emoji: 'legs',
      ex: [
        { id: '0043', mode: 'reps', sets: 4, reps: 3, weight: 145, pyramid: [3, 5, 5, 5], pyramidWeight: [145, 125, 125, 125], restSec: 240, warmupSets: 3, note: 'RPE 8' },
        { id: '1372', mode: 'reps', sets: 4, reps: 10, weight: 80 },
      ],
    })
    expect(api.doc.routines.find(x => x.id === 'mine')).toEqual(BASE().routines[0])
    expect(api.puts[0].stamped).toBeUndefined()
  })

  test('replaces a coach routine in place, and refuses to touch one the athlete made', async () => {
    api = await stubApi({ ...BASE(), routines: [...BASE().routines, { id: 'cc_push', name: 'Push', emoji: 'barbell', ex: [] }] })
    const r = await upsertRoutine.handler({ routine_id: 'cc_push', name: 'Push: bench', exercises: [{ exercise: 'bench press', top_set: { reps: 1, weight: 127.5 } }] }, { env: api.env })
    expect(r.created).toBe(false)
    expect(api.doc.routines.map(x => x.id)).toEqual(['mine', 'cc_push'])
    expect(api.doc.routines[1].name).toBe('Push: bench')
    await expect(upsertRoutine.handler({ routine_id: 'mine', name: 'x', exercises: [{ exercise: 'squat', sets: 1, reps: 1 }] }, { env: api.env })).rejects.toThrow(/not a coach routine/)
  })

  test('an ambiguous name saves nothing and comes back with candidates; a dry run saves nothing either', async () => {
    api = await stubApi(BASE())
    const r = await upsertRoutine.handler({ name: 'Arms', exercises: [{ exercise: 'wrist curl', sets: 3, reps: 15, weight: 20 }] }, { env: api.env })
    expect(r.saved).toBe(false)
    expect(r.problems[0].exercise).toBe('wrist curl')
    expect(r.problems[0].candidates.length).toBeGreaterThan(1)
    const dry = await upsertRoutine.handler({ name: 'Arms', exercises: [{ exercise: 'bench press', sets: 3, reps: 10, weight: 80 }], dry_run: true }, { env: api.env })
    expect(dry).toMatchObject({ saved: false, dry_run: true, name: 'Arms' })
    expect(api.puts).toEqual([])
  })

  test('a phone writing in between is kept: the change is made again on its copy', async () => {
    api = await stubApi(BASE(), { conflictOnce: true })
    const r = await upsertRoutine.handler({ name: 'Pull', exercises: [{ exercise: 'deadlift', sets: 1, reps: 5, weight: 180 }] }, { env: api.env })
    expect(r.saved).toBe(true)
    expect(api.puts).toHaveLength(2)
    expect(api.doc.workouts).toEqual([{ id: 'phone', d: today() }])
    expect(api.doc.routines.some(x => x.name === 'Pull')).toBe(true)
  })

  test('the slot needs sets and reps, or a top set', () => {
    expect(slotOf({ customEx: [] }, { exercise: 'squat', sets: 3 }).problem.problem).toMatch(/sets and reps/)
  })
})

describe('the week', () => {
  test('set_coach_week writes the queue in order, checks the ids, and an empty list ends it', async () => {
    api = await stubApi({ ...BASE(), routines: [...BASE().routines, { id: 'cc_a', name: 'A', ex: [] }, { id: 'cc_b', name: 'B', ex: [] }] })
    const r = await setCoachWeek.handler({ routine_ids: ['cc_b', 'cc_a'], label: 'Week 1' }, { env: api.env })
    expect(r.saved).toBe(true)
    expect(api.doc.queue).toMatchObject({ ids: ['cc_b', 'cc_a'], label: 'Week 1', startsOn: today() })
    expect(typeof api.doc.queue.since).toBe('number')
    expect(api.doc.queue.rotationId).toBeUndefined()
    const bad = await setCoachWeek.handler({ routine_ids: ['cc_a', 'nope'] }, { env: api.env })
    expect(bad.problems).toEqual([{ routine_id: 'nope', problem: 'no routine with this id' }])
    await setCoachWeek.handler({ routine_ids: [] }, { env: api.env })
    expect(api.doc.queue).toBe(null)
  })

  test('delete_coach_routine takes it out of the week too, and leaves the athlete\'s alone', async () => {
    api = await stubApi({ ...BASE(), routines: [...BASE().routines, { id: 'cc_a', name: 'A', ex: [] }], queue: { ids: ['cc_a', 'mine'], since: 1, startsOn: today() } })
    expect((await deleteRoutine.handler({ routine_id: 'cc_a' }, { env: api.env })).deleted).toBe(true)
    expect(api.doc.routines.map(r => r.id)).toEqual(['mine'])
    expect(api.doc.queue.ids).toEqual(['mine'])
    await expect(deleteRoutine.handler({ routine_id: 'mine' }, { env: api.env })).rejects.toThrow(/not a coach routine/)
  })

  test('pin_day sets a session, a rest day or nothing, and only from today on', async () => {
    api = await stubApi(BASE())
    const day = tomorrow()
    expect(await pinDay.handler({ date: day, routine_id: 'mine' }, { env: api.env })).toMatchObject({ saved: true, before: null, after: 'mine' })
    expect(await pinDay.handler({ date: day, rest: true }, { env: api.env })).toMatchObject({ after: 'rest' })
    expect(await pinDay.handler({ date: day, rest: true }, { env: api.env })).toMatchObject({ saved: false, unchanged: true })
    expect(await pinDay.handler({ date: day, clear: true }, { env: api.env })).toMatchObject({ before: 'rest', after: null })
    expect(day in api.doc.dayPlan).toBe(false)
    await expect(pinDay.handler({ date: '2020-01-01', rest: true }, { env: api.env })).rejects.toThrow(/past/)
    await expect(pinDay.handler({ date: day, rest: true, clear: true }, { env: api.env })).rejects.toThrow(/exactly one/)
  })
})

describe('the inbox', () => {
  test('reads, saves notes, and sends the brief with its plan', async () => {
    api = await stubApi(BASE(), { pushed: false })
    const box = await getCoachInbox.handler({ days: 7 }, { env: api.env })
    expect(box.checkins[today()].answer).toBe('skip_pr')
    await saveCoachNotes.handler({ notes: { rotation: 3 } }, { env: api.env })
    const sent = await sendMessage.handler({ title: 'Deadlift PR day', body: 'Work up to 210.', routine_id: 'cc_b_pr', alt_routine_id: 'cc_b', pr: true }, { env: api.env })
    expect(sent).toEqual({ sent: true, pushed: false, message_id: 'm1' })
    expect(api.inbox.map(c => `${c.method} ${c.url}`)).toEqual(['GET /api/coach-inbox?days=7', 'PUT /api/coach-inbox/notes', 'POST /api/coach-inbox/messages'])
    expect(api.inbox[1].body).toEqual({ notes: { rotation: 3 } })
    expect(api.inbox[2].body.plan).toEqual({ routineId: 'cc_b_pr', altRoutineId: 'cc_b', pr: true })
    await expect(sendMessage.handler({ title: 't', body: 'b', pr: true }, { env: api.env })).rejects.toThrow(/routine_id/)
  })

  test('without a server configured every tool says what to set', async () => {
    await expect(getCoachInbox.handler({}, { env: {} })).rejects.toThrow(/OPENGYM_URL/)
  })

  test('the tools are registered with unique names', () => {
    expect(new Set(COACH_TOOLS.map(t => t.name)).size).toBe(COACH_TOOLS.length)
  })
})
