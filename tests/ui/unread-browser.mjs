import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const uiDir = fileURLToPath(new URL('../../ui/', import.meta.url))
const requireUI = createRequire(new URL('../../ui/package.json', import.meta.url))
const { chromium } = requireUI('playwright-core')
const vite = spawn(process.execPath, [fileURLToPath(new URL('../../ui/node_modules/vite/bin/vite.js', import.meta.url)), '--host', '127.0.0.1', '--port', '5974', '--strictPort'], { cwd: uiDir, stdio: 'pipe' })
let serverOutput = ''
vite.stderr.on('data', chunk => { serverOutput += chunk })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null) throw new Error('Vite failed: ' + serverOutput)
    try { if ((await fetch('http://127.0.0.1:5974')).ok) { ready = true; break } } catch (_) {}
    await wait(100)
  }
  assert.ok(ready, 'Vite did not start')
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.testVisible = true
    window.testFocused = true
    Object.defineProperty(document, 'visibilityState', { get: () => window.testVisible ? 'visible' : 'hidden' })
    document.hasFocus = () => window.testFocused
    window.WebSocket = class {
      static OPEN = 1
      readyState = 1
      constructor() { window.testSocket = this; setTimeout(() => this.onopen?.(), 0) }
      send() {}
      close() { this.readyState = 3 }
    }
  })
  const first = '15555550101@s.whatsapp.net'
  const second = '15555550102@s.whatsapp.net'
  const unknown = '15555550103@s.whatsapp.net'
  const time = '2026-01-02T00:00:00.000Z'
  const channels = [
    { jid: first, display_name: 'Friend One', unread_count: 7, unread_known: true },
    { jid: second, display_name: 'Friend Two', unread_count: 3, unread_known: true },
    { jid: unknown, display_name: 'Older Archive', unread_count: null, unread_known: false },
  ].map(row => ({ ...row, type: 'dm', alt_jids: [], last_message: { type: 'text', body: 'Preview', timestamp: time } }))
  const reads = []
  let delayFirst = false
  let failSecond = false
  await page.route('**/api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (!pathname.startsWith('/api/')) return route.continue()
    const path = decodeURIComponent(pathname.slice(4))
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/channels') {
      const search = new URL(request.url()).searchParams.get('search')?.toLowerCase() || ''
      return json(channels.filter(channel => channel.display_name.toLowerCase().includes(search)))
    }
    if (path === '/auth/wa/status') return json({ linked: true, status: 'open' })
    if (path === '/tokens' || path === '/tabs') return json([])
    const match = path.match(/^\/channels\/(.+)\/(messages|read)$/)
    if (match?.[2] === 'messages') {
      if (match[1] === first && delayFirst) await wait(350)
      if (match[1] === second && failSecond) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Test failure"}' })
      return json([{ id: 'message-' + match[1], jid: match[1], timestamp: time, type: 'text', body: match[1] === first ? 'First conversation body' : 'Second conversation body', is_from_me: 0 }]).catch(() => {})
    }
    if (match?.[2] === 'read') {
      reads.push(match[1])
      const channel = channels.find(row => row.jid === match[1])
      channel.unread_count = 0
      channel.unread_known = true
      return json({ unread_count: 0, unread_known: true, unread_mentions: 0, read_up_to: time })
    }
    throw new Error('Unexpected API request: ' + path)
  })
  await page.goto('http://127.0.0.1:5974')
  await page.getByLabel('7 unread messages', { exact: true }).waitFor()
  assert.equal(await page.getByText('99+', { exact: true }).count(), 0)
  await page.getByText('Some chats have no synced read state yet.').waitFor()

  await page.getByText('Friend One', { exact: true }).click()
  await page.getByText('First conversation body', { exact: true }).waitFor()
  await page.getByLabel('7 unread messages', { exact: true }).waitFor({ state: 'detached' })
  assert.deepEqual(reads, [first])

  await page.evaluate(() => { window.testVisible = false; window.testFocused = false; document.dispatchEvent(new Event('visibilitychange')) })
  await page.getByText('Friend Two', { exact: true }).click()
  await page.getByText('Second conversation body', { exact: true }).waitFor()
  await wait(100)
  assert.deepEqual(reads, [first], 'a hidden chat was marked read')
  await page.evaluate(() => { window.testVisible = true; window.testFocused = true; window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  await page.getByLabel('3 unread messages', { exact: true }).waitFor({ state: 'detached' })
  assert.deepEqual(reads, [first, second])

  await page.evaluate(({ jid }) => {
    window.testVisible = false
    document.dispatchEvent(new Event('visibilitychange'))
    window.testSocket.onmessage({ data: JSON.stringify({ event: 'message.new', data: { id: 'new-arrival', jid, canonical_jid: jid, timestamp: '2026-01-03T00:00:00.000Z', type: 'text', body: 'New arrival', is_from_me: 0 } }) })
  }, { jid: second })
  await page.getByText('New arrival', { exact: true }).waitFor()
  await wait(100)
  assert.deepEqual(reads, [first, second], 'a hidden incoming message was marked read')
  await page.evaluate(() => { window.testVisible = true; document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForFunction(() => document.visibilityState === 'visible')
  for (let i = 0; i < 20 && reads.length < 3; i++) await wait(50)
  assert.deepEqual(reads, [first, second, second])

  await page.getByPlaceholder('Search chats...').fill('Older Archive')
  await page.getByText('Friend Two', { exact: true }).first().waitFor({ state: 'detached' })
  const beforeFilteredArrival = reads.length
  await page.evaluate(({ jid }) => {
    window.testSocket.onmessage({ data: JSON.stringify({ event: 'message.new', data: { id: 'filtered-arrival', jid, canonical_jid: jid, timestamp: '2026-01-04T00:00:00.000Z', type: 'text', body: 'Filtered arrival', is_from_me: 0 } }) })
  }, { jid: second })
  await wait(150)
  assert.equal(reads.length, beforeFilteredArrival, 'a conversation hidden by search was marked read')
  await page.getByPlaceholder('Search chats...').fill('')
  await page.getByText('Filtered arrival', { exact: true }).waitFor()

  delayFirst = true
  const beforeSwitch = reads.filter(jid => jid === first).length
  await page.getByText('Friend One', { exact: true }).click()
  await page.getByText('Friend Two', { exact: true }).click()
  await wait(450)
  assert.equal(reads.filter(jid => jid === first).length, beforeSwitch, 'a stale chat response was marked read')
  assert.equal(await page.getByText('First conversation body', { exact: true }).count(), 0)

  delayFirst = false
  await page.getByText('Friend One', { exact: true }).click()
  await page.getByText('First conversation body', { exact: true }).waitFor()
  failSecond = true
  const beforeFailure = reads.filter(jid => jid === second).length
  await page.getByText('Friend Two', { exact: true }).click()
  await wait(200)
  assert.equal(reads.filter(jid => jid === second).length, beforeFailure, 'a failed chat load was marked read')
  assert.deepEqual(errors, [])
  if (process.env.BROWSER_SCREENSHOT) await page.screenshot({ path: process.env.BROWSER_SCREENSHOT })
  console.log('PASS: visible reads, hidden tabs, filtered chats, incoming messages, stale loads, failed loads, and unknown historical counts')
} finally {
  await browser?.close()
  vite.kill('SIGTERM')
}
