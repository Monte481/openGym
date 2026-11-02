// A coach's morning against the real api/server.js in a child process: plan a session, set the
// week, pin a PR day, keep notes, read the check-in, send the brief. Read back off disk and
// through the server's own routes, and through the read tools a run would use next.
// Needs api/'s dependencies (`npm ci` in api/). Without them it skips on a laptop and fails in CI,
// so a green run there always means it ran.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api')
const HAVE_API = fs.existsSync(path.join(API, 'node_modules', '@simplewebauthn', 'server'))
if (!HAVE_API && process.env.CI) throw new Error('api/node_modules is missing: run `npm ci` in api/ before the MCP tests in CI')

const SECRET = crypto.randomBytes(32).toString('hex')
const UID = 'u_mcp_1'
const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}
const TOKEN = mint(UID)
const at = (d, hh) => new Date(`${d}T${hh}:00`).getTime()
// A document the way a device leaves it: settings, a routine, a workout, the records of edits.
const DOC = {
  unit: 'kg', restSec: 120, effort: 'rir', targetW: 80,
  routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 100, mode: 'reps' }], _ts: 1000 }],
  week: { 1: ['r1'] },
  workouts: [{ id: 'w-old', d: '2026-10-13', start: at('2026-10-13', '18:00'), end: at('2026-10-13', '19:00'), routineIds: ['r1'], routineId: 'r1', name: 'Push', prs: [], entries: [{ id: '0025', sets: [{ w: 100, r: 5, done: true }], topW: 100, target: null }] }],
  exWeights: { '0025': { w: 100, d: '2026-10-13' } },
  customEx: [], bodyweight: [{ d: '2026-10-13', w: 80, t: 1000 }],
  deleted: {}, edited: { restSec: 900, effort: 900 },
  _rev: 5, _wid: 'w-seed', _ts: 1000,
}

let child, dataDir, base, log = ''
const get = async p => (await fetch(base + p, { headers: { authorization: 'Bearer ' + TOKEN } })).json()
const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, `state-${UID}.json`), 'utf8'))

describe.skipIf(!HAVE_API)('a coach morning against the real api', () => {
  let C, TOOLS
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-coach-e2e-'))
    fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 })
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: UID, name: 'Timon', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }))
    fs.writeFileSync(path.join(dataDir, `state-${UID}.json`), JSON.stringify(DOC))
    child = spawn(process.execPath, ['server.js'], {
      cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' },
    })
    child.stderr.on('data', d => { log += d })
    const port = await new Promise((resolve, reject) => {
      const give = setTimeout(() => reject(new Error('server never announced a port:\n' + log)), 20000)
      child.stdout.on('data', d => {
        log += d
        const m = /gym-api on :(\d+)/.exec(log)
        if (m) { clearTimeout(give); resolve(+m[1]) }
      })
      child.once('exit', code => { clearTimeout(give); reject(new Error(`server exited (${code}):\n${log}`)) })
    })
    base = `http://127.0.0.1:${port}`
    process.env.OPENGYM_DATA = dataDir
    process.env.OPENGYM_UID = UID
    C = await import('../src/coach-tools.js')
    ;({ TOOLS } = await import('../src/tools.js'))
  }, 30000)
  afterAll(() => {
    child?.kill('SIGKILL')
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const env = () => ({ OPENGYM_URL: base, OPENGYM_TOKEN: TOKEN })
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  const tool = name => TOOLS.find(t => t.name === name)

  test('the whole morning lands, survives the server\'s stamping, and the next run reads it back', async () => {
    const pr = await C.upsertRoutine.handler({ name: 'Legs B: deadlift PR', icon: 'legs', exercises: [
      { exercise: 'deadlift', top_set: { reps: 1, weight: 210 }, rest_sec: 300, warmup_sets: 4 },
      { exercise: 'standing calf raise', sets: 4, reps: 15, weight: 60 },
    ] }, { env: env() })
    const alt = await C.upsertRoutine.handler({ name: 'Legs B', exercises: [{ exercise: 'deadlift', top_set: { reps: 3, weight: 185 }, back_off: { sets: 3, reps: 5, weight: 165 } }] }, { env: env() })
    const push = await C.upsertRoutine.handler({ name: 'Push', exercises: [{ exercise: 'bench press', top_set: { reps: 3, weight: 115 }, back_off: { sets: 3, reps: 6, weight: 100 } }] }, { env: env() })
    for (const r of [pr, alt, push]) expect(r.saved).toBe(true)

    const week = await C.setCoachWeek.handler({ routine_ids: [push.routine_id, pr.routine_id], label: 'Week 1' }, { env: env() })
    expect(week.saved).toBe(true)
    const day = iso(new Date(Date.now() + 2 * 86400000))
    expect((await C.pinDay.handler({ date: day, routine_id: pr.routine_id }, { env: env() })).saved).toBe(true)

    const S = stored()
    expect(S.routines.find(r => r.id === 'r1').name).toBe('Push')            // the athlete's routine is untouched
    expect(S.routines.find(r => r.id === pr.routine_id).ex[0]).toMatchObject({ id: '0032', pyramid: [1], pyramidWeight: [210] })
    expect(S.queue.ids).toEqual([push.routine_id, pr.routine_id])
    expect(S.dayPlan[day]).toBe(pr.routine_id)
    expect(S.workouts.map(w => w.id)).toEqual(['w-old'])                       // the history is untouched
    expect(S.edited.restSec).toBe(900)

    // The read tools, as the next run would call them.
    const plan = await tool('get_week_plan').handler({})
    expect(plan.coach_week.sessions.map(s => s.routine_id)).toEqual([push.routine_id, pr.routine_id])
    expect(plan.days.find(d => d.date === day).routine_ids).toContain(pr.routine_id)

    await C.saveCoachNotes.handler({ notes: { rotation: 1, top: { deadlift: 185 } } }, { env: env() })
    const sent = await C.sendMessage.handler({ title: 'Push today', body: 'Bench 115 x 3, then 3 x 6 at 100.', routine_id: push.routine_id }, { env: env() })
    expect(sent).toMatchObject({ sent: true, pushed: false })
    const box = await C.getCoachInbox.handler({}, { env: env() })
    expect(box.notes).toEqual({ rotation: 1, top: { deadlift: 185 } })
    expect(box.messages.at(-1)).toMatchObject({ title: 'Push today', plan: { routineId: push.routine_id, pr: false } })

    // The athlete's check-in from the app, as the next morning's run reads it.
    const res = await fetch(base + '/api/coach-inbox/checkin', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'own', soreness: 'lots' }) })
    expect(res.status).toBe(200)
    const next = await C.getCoachInbox.handler({}, { env: env() })
    expect(next.checkins[next.today]).toMatchObject({ answer: 'own', soreness: 'lots' })

    expect((await C.deleteRoutine.handler({ routine_id: alt.routine_id }, { env: env() })).deleted).toBe(true)
    expect(stored().routines.some(r => r.id === alt.routine_id)).toBe(false)
  }, 30000)
})
