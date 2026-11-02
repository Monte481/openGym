import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { appBase } from '../lib/app-base.js'
import { t } from '../lib/i18n.js'
import { Section, Row, Button } from './ui.jsx'

// Settings → Account: the token an iPhone Shortcut uses to send last night's sleep from Apple
// Health to the coach inbox (api/coach-inbox.js). It can do nothing else, and it is shown once.
export default function SleepTokenSection() {
  const toast = useUI(s => s.toast)
  const [has, setHas] = useState(null)
  const [token, setToken] = useState(null)
  // Shown only when the server answers with the field: an older server, or none, shows nothing.
  useEffect(() => { api('/api/coach-inbox?days=1').then(r => setHas(typeof r?.sleepToken === 'boolean' ? r.sleepToken : null)).catch(() => setHas(null)) }, [])
  if (has === null) return null

  // Where the app is served. Settings mounts this in the browser only (a phone app's own origin
  // is not the server's), which is also where a Shortcut is set up from.
  const url = location.origin + appBase().replace(/\/$/, '') + '/api/coach-inbox/sleep'
  const make = async () => {
    try { const r = await api('/api/coach-inbox/sleep-token', { method: 'POST', body: '{}' }); setToken(r.token); setHas(true) }
    catch (e) { toast(e?.message || t('Could not save. Try again.')) }
  }
  const remove = async () => {
    try { await api('/api/coach-inbox/sleep-token', { method: 'DELETE' }); setToken(null); setHas(false) }
    catch (e) { toast(e?.message || t('Could not save. Try again.')) }
  }
  const copy = text => navigator.clipboard?.writeText(text).then(() => toast(t('Copied')), () => {})

  return <Section title={t('Sleep for your coach')}
    footer={t('In the Shortcuts app, make a daily automation: Find Health Samples (Sleep Analysis, last night), add up the time asleep in hours, then Get Contents of URL to the address above with method POST, the header Authorization: Bearer and your token, and a JSON body with asleepHours.')}>
    <Row icon="moon" iconTint="var(--indigo)" title={has ? t('Sleep token is set') : t('No sleep token yet')}
      subtitle={t('Lets an iPhone Shortcut send last night’s sleep from Apple Health. It can do nothing else.')} />
    {token && <div style={{ padding: '8px 16px' }}>
      <div className="small muted">{t('Copy it now. It is not shown again.')}</div>
      <code className="small" style={{ display: 'block', overflowWrap: 'anywhere', margin: '6px 0' }}>{token}</code>
      <Button size="sm" icon="copy" onClick={() => copy(token)}>{t('Copy token')}</Button>
    </div>}
    <Row icon="link" iconTint="var(--blue)" title={t('Address for the Shortcut')} subtitle={url} accessory="chevron" onClick={() => copy(url)} />
    <Row icon="key" iconTint="var(--acc)" title={has ? t('Make a new sleep token') : t('Make a sleep token')} accessory="chevron" onClick={make} />
    {has && <Row icon="trash" iconTint="var(--red)" title={t('Remove the sleep token')} danger onClick={remove} />}
  </Section>
}
