/* The coach inbox (coach-inbox.js) against the real server.js in a child: notes, the brief and
   its push, the daily check-in, and the sleep token that lets an iPhone Shortcut file last
   night's sleep without a session. Each profile only ever sees its own. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { sleepOf, checkinPatch, inboxView, createInboxStore } from '../coach-inbox.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const me = { Cookie: `gymsid=${mintSession('u_test_1')}` };
const other = { Cookie: `gymsid=${mintSession('u_test_2')}` };

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-inbox-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_test_1', name: 'One', created: new Date().toISOString() }, { id: 'u_test_2', name: 'Two', created: new Date().toISOString() }],
    creds: [], subs: [], invites: []
  }));
  // Profile one trains in Zagreb: "today" is its date there, not the server's.
  fs.writeFileSync(path.join(dataDir, 'state-u_test_1.json'), JSON.stringify({ reminder: { tz: 'Europe/Zagreb' } }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  const h = { dataDir, log: '' };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  return h;
}
const call = (h, method, p, body, hdr = me) => fetch(`${h.api}${p}`, {
  method, headers: { ...hdr, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined
}).then(async r => ({ status: r.status, body: await r.json() }));
const inbox = (h, hdr = me) => call(h, 'GET', '/api/coach-inbox', undefined, hdr);
const zagrebToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zagreb' }).format(new Date());

test('signed out gets nothing; a new profile has an empty inbox dated in its own zone', async t => {
  const h = await startServer(t);
  assert.equal((await inbox(h, {})).status, 401);
  assert.equal((await call(h, 'POST', '/api/coach-inbox/checkin', { answer: 'rest' }, {})).status, 401);
  const r = await inbox(h);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { today: zagrebToday(), notes: null, notesAt: null, messages: [], checkins: {}, sleepToken: false });
});

test('notes round-trip, are capped at 64 KB, and stay with their profile', async t => {
  const h = await startServer(t);
  const notes = { rotation: 3, top: { bench: 115, squat: 150 }, lastPr: { deadlift: '2026-10-20' } };
  assert.equal((await call(h, 'PUT', '/api/coach-inbox/notes', { notes })).status, 200);
  assert.deepEqual((await inbox(h)).body.notes, notes);
  assert.equal((await inbox(h, other)).body.notes, null, 'the other profile sees none of it');
  assert.equal((await call(h, 'PUT', '/api/coach-inbox/notes', { notes: 'x'.repeat(70000) })).status, 413);
  assert.equal((await call(h, 'PUT', '/api/coach-inbox/notes', {})).status, 400);
  assert.deepEqual((await inbox(h)).body.notes, notes, 'a refused write changes nothing');
});

test('a check-in sets only what was sent, checks every field, and defaults to today', async t => {
  const h = await startServer(t);
  let r = await call(h, 'POST', '/api/coach-inbox/checkin', { answer: 'skip_pr', request: '  heavy deadlift Friday  ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.date, zagrebToday());
  assert.equal(r.body.checkin.answer, 'skip_pr');
  assert.equal(r.body.checkin.request, 'heavy deadlift Friday');
  r = await call(h, 'POST', '/api/coach-inbox/checkin', { soreness: 'some', sleep: { quality: 'poor' } });
  assert.equal(r.body.checkin.answer, 'skip_pr', 'the answer stays');
  assert.equal(r.body.checkin.soreness, 'some');
  assert.deepEqual(r.body.checkin.sleep, { source: 'app', quality: 'poor' });

  for (const bad of [{ answer: 'maybe' }, { soreness: 'very' }, { date: '2026-13-45', answer: 'rest' }, {}, { sleep: {} }, { request: 5 }]) {
    const res = await call(h, 'POST', '/api/coach-inbox/checkin', bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.code, 'invalid');
  }
  await call(h, 'POST', '/api/coach-inbox/checkin', { date: '2025-01-01', answer: 'rest' });
  const box = (await inbox(h, me)).body;
  assert.equal(box.checkins['2025-01-01'], undefined, 'outside the default 14 days');
  assert.equal(box.checkins[zagrebToday()].answer, 'skip_pr');
  assert.ok(fs.readFileSync(path.join(h.dataDir, 'coach-inbox-u_test_1.json'), 'utf8').includes('2025-01-01'), 'kept, only not shown');
});

test('a message is stored, says when no device could be pushed to, and is capped at 6 a day', async t => {
  const h = await startServer(t);
  const r = await call(h, 'POST', '/api/coach-inbox/messages', { title: 'Legs A today', body: 'Squat top set 140 x 5 @ RPE 8.\nEat by 17:00.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.pushed, false, 'no subscription on this profile');
  assert.match(r.body.message.id, /^m[0-9a-f]{12}$/);
  assert.equal((await inbox(h)).body.messages.at(-1).title, 'Legs A today');
  assert.equal((await call(h, 'POST', '/api/coach-inbox/messages', { title: 'x' })).status, 400);
  const pr = await call(h, 'POST', '/api/coach-inbox/messages', { title: 'PR day', body: 'Deadlift 210.', plan: { routineId: 'cc_legs_b_pr', altRoutineId: 'cc_legs_b', pr: true } });
  assert.deepEqual(pr.body.message.plan, { routineId: 'cc_legs_b_pr', altRoutineId: 'cc_legs_b', pr: true });
  assert.equal((await call(h, 'POST', '/api/coach-inbox/messages', { title: 't', body: 'b', plan: { routineId: '../x' } })).status, 400);
  for (let i = 0; i < 4; i++) assert.equal((await call(h, 'POST', '/api/coach-inbox/messages', { title: 't', body: 'b' })).status, 200);
  const over = await call(h, 'POST', '/api/coach-inbox/messages', { title: 't', body: 'b' });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, 'locked');
  assert.equal((await call(h, 'POST', '/api/coach-inbox/messages', { title: 't', body: 'b' }, other)).status, 200, 'per profile');
});

test('the sleep token files a night without a session, is stored hashed, and does nothing else', async t => {
  const h = await startServer(t);
  const { token } = (await call(h, 'POST', '/api/coach-inbox/sleep-token', {})).body;
  assert.match(token, /^st\.u_test_1\.[0-9a-f]{64}$/);
  assert.equal((await inbox(h)).body.sleepToken, true);
  const raw = fs.readFileSync(path.join(h.dataDir, 'coach-inbox-u_test_1.json'), 'utf8');
  assert.ok(!raw.includes(token.split('.')[2]), 'the token itself is never on disk');

  const bearer = tok => ({ Authorization: 'Bearer ' + tok });
  let r = await call(h, 'POST', '/api/coach-inbox/sleep', { asleepHours: 7.25, deepMin: 62, hrv: 48 }, bearer(token));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sleep, { source: 'health', asleepMin: 435, deepMin: 62, hrv: 48 });
  // The app's own word on the same night joins the watch's numbers.
  r = await call(h, 'POST', '/api/coach-inbox/checkin', { sleep: { quality: 'good' } });
  assert.deepEqual(r.body.checkin.sleep, { source: 'both', asleepMin: 435, deepMin: 62, hrv: 48, quality: 'good' });

  // It is not a session: no inbox, no profile.
  assert.equal((await call(h, 'GET', '/api/coach-inbox', undefined, bearer(token))).status, 401);
  assert.equal((await call(h, 'GET', '/api/data', undefined, bearer(token))).status, 401);
  // Another profile's id in a token made for this one is refused.
  assert.equal((await call(h, 'POST', '/api/coach-inbox/sleep', { asleepMin: 400 }, bearer(token.replace('u_test_1', 'u_test_2')))).status, 401);
  assert.equal((await call(h, 'POST', '/api/coach-inbox/sleep', { asleepMin: 400 }, {})).status, 401);
  assert.equal((await call(h, 'POST', '/api/coach-inbox/sleep', { nothing: 1 }, bearer(token))).status, 400);

  // A new token retires the old; deleting retires the new.
  const second = (await call(h, 'POST', '/api/coach-inbox/sleep-token', {})).body.token;
  assert.equal((await call(h, 'POST', '/api/coach-inbox/sleep', { asleepMin: 400 }, bearer(token))).status, 401);
  assert.equal((await call(h, 'POST', '/api/coach-inbox/sleep', { asleepMin: 400 }, bearer(second))).status, 200);
  assert.equal((await call(h, 'DELETE', '/api/coach-inbox/sleep-token', undefined)).status, 200);
  assert.equal((await call(h, 'POST', '/api/coach-inbox/sleep', { asleepMin: 400 }, bearer(second))).status, 401);
});

test('the pure parts: sleep units, patches and the view', () => {
  assert.deepEqual(sleepOf({ asleepMin: 401.6, restingHr: 52, hrv: 'x' }, 'health'), { source: 'health', asleepMin: 402, restingHr: 52 });
  assert.throws(() => sleepOf({ asleepMin: -3 }, 'app'), /asleepMin/);
  assert.throws(() => sleepOf({ quality: 'great' }, 'app'), /quality/);
  assert.deepEqual(checkinPatch({ answer: 'own', soreness: null, request: '' }), { answer: 'own', soreness: null, request: null });
  const view = inboxView({ notes: 1, notesAt: 2, messages: Array.from({ length: 30 }, (_, i) => ({ id: i })), checkins: { '2026-01-01': {}, junk: {} }, sleepToken: { h: 'x' } });
  assert.equal(view.messages.length, 20);
  assert.deepEqual(Object.keys(view.checkins), ['2026-01-01']);
  assert.equal(view.sleepToken, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-inbox-store-'));
  const store = createInboxStore(dir);
  assert.throws(() => store.load('../db'), /bad uid/);
  fs.writeFileSync(store.file('u1'), '{not json');
  assert.deepEqual(store.load('u1').messages, [], 'an unreadable file reads as empty');
  fs.rmSync(dir, { recursive: true, force: true });
});
