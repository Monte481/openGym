/* The coach inbox: what an outside coach (an LLM on a schedule, reaching in through the MCP
 * server) and the athlete leave each other between runs.
 *
 *   notes     the coach's own memory of the program: rotation position, top-set weights, PR
 *             dates, milestones. Free JSON, read back by the next run, never shown in the app.
 *   messages  the morning brief and anything else the coach sends. Each one is stored here and
 *             pushed to the profile's devices; the Home card shows the newest.
 *   checkins  one per day, what the athlete answered: train as planned, swap, skip the PR, an
 *             own workout, or no training; soreness; a line for the coach; and last night's
 *             sleep, which can also come from an iPhone Shortcut on its own token.
 *
 * Kept out of the synced profile on purpose. Nothing here is edited on two devices at once, and
 * putting it into state-<uid>.json would mean teaching both copies of the sync merge
 * (lib/sync-merge.js and sync-stamps.js) about it. One small file per profile instead,
 * DATA_DIR/coach-inbox-<uid>.json, written the same durable way as everything else.
 *
 * Written as a factory taking server.js's helpers, like coach/routes.js.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './durable.js';
import { createWindow } from './rate-limit.js';

export const INBOX_LIMITS = {
  notesBytes: 64 * 1024,
  messages: 60,
  titleChars: 120,
  bodyChars: 4000,
  requestChars: 280,
  checkinDays: 120,
};
export const ANSWERS = ['planned', 'swap', 'skip_pr', 'own', 'rest'];
export const SORENESS = ['none', 'some', 'lots'];
export const SLEEP_QUALITY = ['good', 'ok', 'poor'];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^st\.([A-Za-z0-9_-]{1,64})\.([0-9a-f]{64})$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isDate = v => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// A number in [lo, hi], or undefined for anything else (absent, a string, NaN).
const inRange = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

export class InboxError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (message, code = 'invalid') => new InboxError(400, message, code);

const empty = () => ({ notes: null, notesAt: null, messages: [], checkins: {}, sleepToken: null });

/** The file store. Exported on its own so the tests can drive it without a server. */
export function createInboxStore(dir) {
  const file = uid => {
    if (!UID.test(uid)) throw new Error('bad uid');
    return path.join(dir, `coach-inbox-${uid}.json`);
  };
  const load = uid => {
    const f = file(uid);   // outside the try: a bad uid is a bug to hear about, not an empty inbox
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v)) return empty();
      return {
        ...empty(), ...v,
        messages: Array.isArray(v.messages) ? v.messages : [],
        checkins: v.checkins && typeof v.checkins === 'object' && !Array.isArray(v.checkins) ? v.checkins : {},
      };
    } catch { return empty(); }   // none yet, or unreadable: an empty inbox, never a 500
  };
  const save = (uid, box) => atomicWrite(file(uid), JSON.stringify(box), 0o600);
  const forget = uid => { try { fs.unlinkSync(file(uid)); } catch { /* none */ } };
  return { load, save, forget, file };
}

/** The oldest days past the cap go, so a year of daily check-ins does not grow the file forever. */
function pruneCheckins(checkins) {
  const days = Object.keys(checkins).filter(isDate).sort();
  const out = {};
  for (const d of days.slice(-INBOX_LIMITS.checkinDays)) out[d] = checkins[d];
  return out;
}

/** A check-in body, checked, as the fields it sets. Only the fields sent are touched. */
export function checkinPatch(body) {
  const p = {};
  if (body.answer !== undefined) {
    if (!ANSWERS.includes(body.answer)) throw bad(`answer must be one of ${ANSWERS.join(', ')}`);
    p.answer = body.answer;
  }
  if (body.soreness !== undefined) {
    if (body.soreness !== null && !SORENESS.includes(body.soreness)) throw bad(`soreness must be one of ${SORENESS.join(', ')}`);
    p.soreness = body.soreness;
  }
  if (body.request !== undefined) {
    if (body.request !== null && typeof body.request !== 'string') throw bad('request must be text');
    p.request = str(body.request, INBOX_LIMITS.requestChars) || null;
  }
  if (body.sleep !== undefined) p.sleep = body.sleep === null ? null : sleepOf(body.sleep, 'app');
  if (!Object.keys(p).length) throw bad('nothing to save');
  return p;
}

/**
 * Last night's sleep as stored. Takes minutes or hours for the time asleep (a Shortcut sums
 * Health's samples in whichever unit it was built with), plus optional detail from the watch.
 */
export function sleepOf(s, source) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad('sleep must be an object');
  const asleepMin = inRange(s.asleepMin, 0, 1440) ?? (inRange(s.asleepHours, 0, 24) !== undefined ? Math.round(s.asleepHours * 60) : undefined);
  const quality = s.quality === undefined ? undefined : SLEEP_QUALITY.includes(s.quality) ? s.quality : null;
  if (quality === null) throw bad(`sleep quality must be one of ${SLEEP_QUALITY.join(', ')}`);
  if (asleepMin === undefined && quality === undefined) throw bad('sleep needs asleepMin (or asleepHours) or a quality');
  const out = { source };
  if (asleepMin !== undefined) out.asleepMin = Math.round(asleepMin);
  if (quality !== undefined) out.quality = quality;
  for (const [k, lo, hi] of [['deepMin', 0, 1440], ['remMin', 0, 1440], ['hrv', 0, 500], ['restingHr', 20, 250]]) {
    const v = inRange(s[k], lo, hi);
    if (v !== undefined) out[k] = Math.round(v);
  }
  return out;
}

const DAY_MS = 86400000;
const minusDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * DAY_MS).toISOString().slice(0, 10);

/** What the app and the MCP server read: everything but the sleep token's hash. The check-ins
 *  are the `days` calendar days up to `today`, plus any filed ahead of it. */
export function inboxView(box, { days = 14, today = null } = {}) {
  const from = today && isDate(today) ? minusDays(today, days - 1) : '';
  const dates = Object.keys(box.checkins).filter(d => isDate(d) && d >= from).sort();
  return {
    notes: box.notes,
    notesAt: box.notesAt,
    messages: box.messages.slice(-20),
    checkins: Object.fromEntries(dates.map(d => [d, box.checkins[d]])),
    sleepToken: !!box.sleepToken,
  };
}

/**
 * The routes. `findUser(uid)` answers the user record of a live profile (not disabled), for the
 * sleep token, which arrives without a session. `todayFor(uid)` is the profile's own date
 * (its reminder time zone), the default day for a check-in or a night's sleep.
 */
export function coachInboxRoutes({ json, readBody, readSession, sendPush, pushTargets, findUser, todayFor, store }) {
  const MESSAGES = createWindow({ max: 6, windowMs: 24 * 3600000 });
  const WRITES = createWindow({ max: 120, windowMs: 3600000 });
  const SLEEP = createWindow({ max: 20, windowMs: 3600000 });
  setInterval(() => { MESSAGES.sweep(); WRITES.sweep(); SLEEP.sweep(); }, 600000).unref();

  const throttled = (res, win, key) => {
    const wait = win.take(key);
    if (!wait) return false;
    json(res, 429, { error: 'too many requests, try again later', code: 'locked', retryAfter: wait }, { 'Retry-After': String(wait) });
    return true;
  };
  const signedIn = (req, res) => {
    const user = readSession(req);
    if (!user) json(res, 401, { error: 'not signed in' });
    return user;
  };
  const fail = (res, e) => {
    if (e instanceof InboxError) return json(res, e.status, { error: e.message, code: e.code });
    throw e;
  };
  const dayOf = (v, uid) => {
    if (v === undefined || v === null || v === '') return todayFor(uid);
    if (!isDate(v)) throw bad('date must be YYYY-MM-DD');
    return v;
  };
  const putCheckin = (uid, date, patch) => {
    const box = store.load(uid);
    const prev = box.checkins[date] || {};
    const next = { ...prev, ...patch, at: Date.now() };
    // A night the Shortcut sent and an answer typed in the app sit side by side: the app's
    // "how did you sleep" does not wipe the watch's numbers, it adds its own word.
    if (patch.sleep && prev.sleep && patch.sleep.source !== prev.sleep.source) next.sleep = { ...prev.sleep, ...patch.sleep, source: 'both' };
    box.checkins = pruneCheckins({ ...box.checkins, [date]: next });
    store.save(uid, box);
    return next;
  };

  return {
    'GET /api/coach-inbox': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const days = Math.min(120, Math.max(1, +new URL(req.url, 'http://x').searchParams.get('days') || 14));
      const today = todayFor(user.id);
      json(res, 200, { today, ...inboxView(store.load(user.id), { days, today }) });
    },

    'PUT /api/coach-inbox/notes': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (throttled(res, WRITES, user.id)) return;
      const body = await readBody(req);
      if (!('notes' in body)) return json(res, 400, { error: 'notes required', code: 'invalid' });
      const text = JSON.stringify(body.notes ?? null);
      if (Buffer.byteLength(text) > INBOX_LIMITS.notesBytes) return json(res, 413, { error: `notes are over ${INBOX_LIMITS.notesBytes / 1024} KB`, code: 'too-big' });
      const box = store.load(user.id);
      box.notes = body.notes ?? null;
      box.notesAt = Date.now();
      store.save(user.id, box);
      json(res, 200, { ok: true, notesAt: box.notesAt });
    },

    'POST /api/coach-inbox/messages': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const body = await readBody(req);
      const title = str(body.title, INBOX_LIMITS.titleChars);
      const text = str(body.body, INBOX_LIMITS.bodyChars);
      if (!title || !text) return json(res, 400, { error: 'title and body required', code: 'invalid' });
      // A brief can say which routine it planned for today, and on a PR day the regular session
      // to fall back on: the Home card's "Skip the PR" pins that one without asking anyone.
      let plan = null;
      if (body.plan != null) {
        const id = v => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null);
        if (typeof body.plan !== 'object' || Array.isArray(body.plan) || !id(body.plan.routineId)) return json(res, 400, { error: 'plan needs a routineId', code: 'invalid' });
        if (body.plan.altRoutineId != null && !id(body.plan.altRoutineId)) return json(res, 400, { error: 'plan.altRoutineId is not a routine id', code: 'invalid' });
        plan = { routineId: body.plan.routineId, ...(body.plan.altRoutineId ? { altRoutineId: body.plan.altRoutineId } : {}), pr: body.plan.pr === true };
      }
      if (throttled(res, MESSAGES, user.id)) return;
      const box = store.load(user.id);
      const msg = { id: 'm' + crypto.randomBytes(6).toString('hex'), at: Date.now(), date: todayFor(user.id), title, body: text, ...(plan ? { plan } : {}) };
      box.messages = [...box.messages, msg].slice(-INBOX_LIMITS.messages);
      store.save(user.id, box);
      // The notification carries the title and the first line only; the whole brief is on Home.
      const first = text.split('\n').find(l => l.trim()) || text;
      // `pushed` says whether any device was there to send to, so a coach can tell the athlete
      // to switch notifications on rather than assume the brief arrived.
      let pushed = false;
      if (pushTargets(user.id) > 0) {
        try { await sendPush(user.id, { title, body: first.slice(0, 180), tag: 'coach-brief' }); pushed = true; }
        catch (e) { console.error('coach-inbox: push failed for', user.id, e?.message || e); }
      }
      json(res, 200, { ok: true, message: msg, pushed });
    },

    'POST /api/coach-inbox/checkin': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (throttled(res, WRITES, user.id)) return;
      const body = await readBody(req);
      try {
        const date = dayOf(body.date, user.id);
        json(res, 200, { ok: true, date, checkin: putCheckin(user.id, date, checkinPatch(body)) });
      } catch (e) { fail(res, e); }
    },

    // A fresh token for the sleep route, shown once. Making a new one retires the old.
    'POST /api/coach-inbox/sleep-token': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (throttled(res, WRITES, user.id)) return;
      const token = `st.${user.id}.${crypto.randomBytes(32).toString('hex')}`;
      const box = store.load(user.id);
      box.sleepToken = { h: sha(token), created: Date.now() };
      store.save(user.id, box);
      json(res, 200, { ok: true, token });
    },

    'DELETE /api/coach-inbox/sleep-token': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const box = store.load(user.id);
      box.sleepToken = null;
      store.save(user.id, box);
      json(res, 200, { ok: true });
    },

    // Last night's sleep, from an iPhone Shortcut or anything else that can POST. Authorised by
    // the sleep token alone (Authorization: Bearer st.…), which can do nothing but this.
    'POST /api/coach-inbox/sleep': async (req, res) => {
      const auth = req.headers.authorization || '';
      const m = TOKEN.exec(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
      const uid = m?.[1];
      const box = uid && findUser(uid) ? store.load(uid) : null;
      const ok = box?.sleepToken?.h && crypto.timingSafeEqual(Buffer.from(box.sleepToken.h, 'hex'), Buffer.from(sha(m[0]), 'hex'));
      if (!ok) return json(res, 401, { error: 'sleep token not accepted', code: 'token' });
      if (throttled(res, SLEEP, uid)) return;
      const body = await readBody(req);
      try {
        const date = dayOf(body.date, uid);
        json(res, 200, { ok: true, date, sleep: putCheckin(uid, date, { sleep: sleepOf(body, 'health') }).sleep });
      } catch (e) { fail(res, e); }
    },
  };
}
