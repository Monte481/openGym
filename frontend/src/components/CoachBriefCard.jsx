import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { DEMO } from '../lib/demo.js'
import { t } from '../lib/i18n.js'
import { effectiveRoutineIds } from '../lib/history.js'
import { todaysBrief, latestBrief, swapChoices, dayPlanChange, applyDayPlanChange, sleepParts } from '../lib/coach-inbox.js'
import { Button, TextField } from './ui.jsx'
import Icon from './Icon.jsx'

// The morning brief from an outside coach and the day's check-in (lib/coach-inbox.js). Shown only
// once a coach has sent something: a profile that never connected one sees nothing new on Home.
const ANSWER_LABELS = [
  ['planned', 'As planned'], ['swap', 'Swap session'], ['skip_pr', 'Skip the PR'],
  ['own', 'My own workout'], ['rest', 'Not training today'],
]
const SORENESS_LABELS = [['none', 'Not sore'], ['some', 'A bit sore'], ['lots', 'Very sore']]
const SLEEP_LABELS = [['good', 'Slept well'], ['ok', 'Slept OK'], ['poor', 'Slept badly']]
const LONG = 320

export default function CoachBriefCard() {
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const [inbox, setInbox] = useState(null)
  const [open, setOpen] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)

  // Keyed on the id, not the user object: a fresh object for the same profile is no reason to
  // read again, and a read landing after an answer would show the answer undone.
  const uid = user?.id || null
  const load = useCallback(() => {
    if (!uid || DEMO) return
    api('/api/coach-inbox').then(setInbox).catch(() => { /* offline or an older server: no card */ })
  }, [uid])
  useEffect(() => {
    load()
    const onShow = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [load])

  if (!inbox || !Array.isArray(inbox.messages) || !inbox.messages.length) return null
  const today = inbox.today
  const brief = todaysBrief(inbox, today) || latestBrief(inbox)
  const isToday = brief.date === today
  const checkin = inbox.checkins?.[today] || {}
  const plannedId = (isToday && brief.plan?.routineId) || effectiveRoutineIds(S, today)[0] || null
  const isPr = isToday && brief.plan?.pr === true && !!brief.plan.altRoutineId

  const send = async (patch, change) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await api('/api/coach-inbox/checkin', { method: 'POST', body: JSON.stringify({ date: today, ...patch }) })
      setInbox(b => ({ ...b, checkins: { ...b.checkins, [today]: r.checkin } }))
      if (change) update(s => applyDayPlanChange(s, today, change))
      return true
    } catch (e) {
      toast(e?.message || t('Could not save. Try again.'))
      return false
    } finally { setBusy(false) }
  }
  const answer = (a, swapTo) => {
    if (a === 'swap' && !swapTo) { setSwapping(v => !v); return }
    setSwapping(false)
    send({ answer: a }, dayPlanChange(S, today, a, { brief, swapTo }))
  }
  const sendRequest = async () => {
    const text = request.trim()
    if (text && await send({ request: text })) { setRequest(''); toast(t('Sent to your coach')) }
  }

  const long = brief.body.length > LONG
  const shown = open || !long ? brief.body : brief.body.slice(0, LONG).replace(/\s+\S*$/, '') + '…'
  const slept = sleepParts(checkin.sleep)
  const choices = swapping ? swapChoices(S, today, plannedId) : []

  return <div className="card coach-brief">
    <div className="row" style={{ gap: 9, marginBottom: 6 }}>
      <span className="lrow-i" style={{ background: 'var(--purple, var(--acc))' }}><Icon name="chat" /></span>
      <div style={{ minWidth: 0 }}>
        <div className="cb-lbl">{isToday ? t('From your coach') : t('Last brief from your coach')}</div>
        <div className="cb-ttl">{brief.title}</div>
      </div>
    </div>
    <div className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{shown}</div>
    {long && <Button size="sm" variant="ghost" onClick={() => setOpen(v => !v)}>{open ? t('Show less') : t('Show more')}</Button>}

    {isToday && <>
      <div className="cb-q">{t('Training today?')}</div>
      <div className="chips">
        {ANSWER_LABELS.filter(([a]) => a !== 'skip_pr' || isPr).map(([a, label]) =>
          <button key={a} type="button" disabled={busy} aria-pressed={checkin.answer === a}
            className={'chip' + (checkin.answer === a || (a === 'swap' && swapping) ? ' on' : '')}
            onClick={() => answer(a)}>{t(label)}</button>)}
      </div>
      {swapping && <div className="chips" style={{ marginTop: 6 }} aria-label={t('Pick a session')}>
        {choices.length ? choices.map(c => <button key={c.id} type="button" className="chip" disabled={busy} onClick={() => answer('swap', c.id)}>{c.name}</button>)
          : <span className="muted small">{t('Nothing else to swap to this week.')}</span>}
      </div>}

      <div className="cb-q">{t('How do you feel?')}</div>
      <div className="chips">
        {SORENESS_LABELS.map(([v, label]) =>
          <button key={v} type="button" disabled={busy} aria-pressed={checkin.soreness === v}
            className={'chip' + (checkin.soreness === v ? ' on' : '')}
            onClick={() => send({ soreness: checkin.soreness === v ? null : v })}>{t(label)}</button>)}
      </div>
      {slept && <div className="small muted cb-sleep">{t('Slept {0} h {1} min', slept.h, slept.min)}</div>}
      <div className="chips">
        {SLEEP_LABELS.map(([v, label]) =>
          <button key={v} type="button" disabled={busy} aria-pressed={checkin.sleep?.quality === v}
            className={'chip' + (checkin.sleep?.quality === v ? ' on' : '')}
            onClick={() => send({ sleep: { quality: v } })}>{t(label)}</button>)}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <TextField value={request} maxLength={280} placeholder={t('A note for your coach')}
          aria-label={t('A note for your coach')} style={{ flex: 1 }}
          onChange={e => setRequest(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') sendRequest() }} />
        <Button size="sm" disabled={busy || !request.trim()} onClick={sendRequest}>{t('Send')}</Button>
      </div>
      {checkin.request && <div className="small muted" style={{ marginTop: 6 }}>{t('Your note: {0}', checkin.request)}</div>}
    </>}
  </div>
}
