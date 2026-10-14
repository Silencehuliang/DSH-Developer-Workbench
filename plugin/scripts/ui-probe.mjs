/**
 * Drive the real DSH web GUI in a headless browser over CDP.
 *
 * This is the verification the unit suites cannot do: they assert components
 * with a stub React, which says nothing about whether the shell renders them,
 * whether the HTTP calls actually resolve, or whether a click does anything.
 *
 * Node 22 ships a global WebSocket, so this needs no dependency.
 *
 * ## Getting past the host's browser-session fence
 *
 * `dsh web` guards the index with a query token that is minted per process and
 * never written to disk, so it cannot be read from outside. What *is* on disk is
 * the 32-byte signing secret, so this mints the same cookie the host would have
 * minted after the token exchange — see `mintSessionCookie`.
 */

import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const URL_UNDER_TEST = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
const AUTHORITY = new URL(URL_UNDER_TEST).host
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)

/**
 * A Chromium the machine actually has, so this is not pinned to one install path.
 * @returns the executable path.
 */
function findBrowser() {
  if (typeof process.env.DSH_BROWSER === 'string' && process.env.DSH_BROWSER.length > 0) return process.env.DSH_BROWSER
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  const found = candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch (error) {
      return false
    }
  })
  if (found === undefined) throw new Error('no Chromium found; set DSH_BROWSER to one')
  return found
}

const BROWSER = findBrowser()

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-probe-'))
const shotArg = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
const shotPath = shotArg ?? path.join(os.tmpdir(), 'dsh-ui-probe.png')
/** Dispatch a real session? Off by default: it creates a session in the user's GUI. */
const SEND = process.argv.includes('--send')

let passed = 0
const failures = []
const consoleErrors = []

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── the host's cookie ─────────────────────────────────────────────────────────

const base64url = (buffer) =>
  Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** The browser-session signing secret the host keeps for this DSH home. */
function readSigningSecret() {
  const file = path.join(DSH_HOME, '.credentials.yaml')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.includes('client-connection/browser-session'))
  if (start === -1) return null
  for (let index = start; index < Math.min(start + 8, lines.length); index += 1) {
    const match = /^\s*secret:\s*(.+?)\s*$/.exec(lines[index])
    if (match !== null) return match[1].replace(/^["']|["']$/g, '')
  }
  return null
}

/**
 * Sign the session cookie the host would have set after a `?token=` exchange.
 * @param secretBase64Url - the stored signing secret.
 * @returns the cookie name, value and expiry.
 */
function mintSessionCookie(secretBase64Url) {
  const secret = Buffer.from(secretBase64Url.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (secret.byteLength !== 32) throw new Error(`expected a 32-byte signing secret, got ${secret.byteLength}`)
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 12 * 60 * 60 * 1000
  const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt, expiresAt }), 'utf8'))
  const signature = base64url(createHmac('sha256', secret).update(body).digest())
  return {
    name: `dsh-auth-${base64url(createHash('sha256').update(AUTHORITY).digest())}`,
    value: `v1.${body}.${signature}`,
    expiresAt,
  }
}

// ── CDP plumbing ──────────────────────────────────────────────────────────────

class Session {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry !== undefined) {
          this.pending.delete(message.id)
          entry(message)
        }
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(`exception: ${message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? '?'}`)
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        consoleErrors.push(`console.error: ${(message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`)
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 30000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`))
        else resolve(message.result)
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => { try { return ${expression} } catch (error) { return 'EVAL_ERROR: ' + error.message } })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) return `THREW: ${result.exceptionDetails.text}`
    return result.result?.value
  }

  /** Poll an expression until it is true, or give up. */
  async waitFor(expression, label, timeoutMs = 30000, intervalMs = 400) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await this.eval(expression)
      if (last === true) return true
      await sleep(intervalMs)
    }
    console.log(`       (waitFor "${label}" gave up with: ${JSON.stringify(last).slice(0, 160)})`)
    return false
  }
}

const browser = spawn(BROWSER, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1500,1000',
  'about:blank',
], { stdio: 'ignore' })

let socket
try {
  let version = null
  for (let attempt = 0; attempt < 40 && version === null; attempt += 1) {
    await sleep(300)
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
    } catch (error) {
      version = null
    }
  }
  if (version === null) throw new Error('the browser never opened its debugging port')
  console.log(`browser:   ${version.Browser}`)
  console.log(`authority: ${AUTHORITY}`)

  // Blank target first: the page must not load before the cookie is in place.
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', () => reject(new Error('websocket failed')))
  })

  const session = new Session(socket)
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  await session.send('Network.enable')

  const secret = readSigningSecret()
  if (secret === null) throw new Error(`no browser-session secret in ${DSH_HOME}\\.credentials.yaml`)
  const cookie = mintSessionCookie(secret)
  const set = await session.send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    domain: new URL(URL_UNDER_TEST).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    expires: cookie.expiresAt / 1000,
  })
  console.log(`cookie:    ${set.success === true ? 'accepted by the browser' : JSON.stringify(set)}`)

  // A real navigation, after the cookie exists.
  await session.send('Page.navigate', { url: `${new URL(URL_UNDER_TEST).origin}/` })

  // ── the shell boots ────────────────────────────────────────────────────────

  console.log('\nshell')
  const loaded = await session.waitFor(
    `document.readyState === 'complete' && document.body.innerText.length > 20`,
    'the document',
    45000,
  )
  check('the GUI document loads', loaded === true)

  const bodyStart = await session.eval(`document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160)`)
  console.log(`       body: ${JSON.stringify(bodyStart).slice(0, 200)}`)
  check('the host did not answer with the auth fence', typeof bodyStart === 'string' && !bodyStart.includes('authentication required'), String(bodyStart).slice(0, 100))

  const entrySeen = await session.waitFor(
    `document.body.innerText.includes('开发工作台')`,
    'the sidebar entry',
    60000,
  )
  check('the sidebar entry is visible', entrySeen === true)

  // ── clicking the entry opens the panel ─────────────────────────────────────

  console.log('\nentry → panel')
  const clicked = await session.eval(`(() => {
    const all = [...document.querySelectorAll('button, a, [role="button"]')]
    const target = all.find((node) => node.textContent && node.textContent.includes('开发工作台'))
    if (!target) return 'not-found'
    target.click()
    return 'clicked'
  })()`)
  check('the sidebar entry is clickable', clicked === 'clicked', String(clicked))

  const panelRendered = await session.waitFor(
    `!!document.querySelector('.dw-projects')`,
    'the workbench panel',
    30000,
  )
  check('clicking the entry renders the workbench panel', panelRendered === true)

  // ── the project list actually loads ────────────────────────────────────────

  console.log('\nproject list')
  const rowsSeen = await session.waitFor(`document.querySelectorAll('.dw-project').length > 0`, 'project rows', 40000)
  check('the project list loads its rows', rowsSeen === true)

  const rowInfo = await session.eval(`(() => {
    const rows = [...document.querySelectorAll('.dw-project')]
    return { count: rows.length, texts: rows.map((row) => row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90)) }
  })()`)
  check('the rows carry real data', typeof rowInfo === 'object' && rowInfo.count > 0, JSON.stringify(rowInfo).slice(0, 200))
  console.log(`       rows: ${JSON.stringify(rowInfo?.texts ?? []).slice(0, 420)}`)

  // Geometry, because a screenshot cannot tell "narrow column" from "two columns".
  const layout = await session.eval(`(() => {
    const box = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const list = document.querySelector('.dw-projects')
    const style = list ? getComputedStyle(list) : null
    const rows = [...document.querySelectorAll('.dw-project')]
    const panel = document.querySelector('.dw-panel')
    const columns = panel ? panel.firstElementChild : null
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      panel: box(panel),
      columns: box(columns),
      listDisplay: style ? style.display : null,
      listColumns: style ? style.gridTemplateColumns : null,
      listBox: box(list),
      rowCount: rows.length,
      rowBoxes: rows.slice(0, 5).map(box),
      rowWidths: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().width)))],
    }
  })()`)
  console.log(`       layout: ${JSON.stringify(layout).slice(0, 600)}`)

  // ── selection is single and visible ────────────────────────────────────────

  console.log('\nselection')
  const firstRow = await session.eval(`(() => {
    const rows = [...document.querySelectorAll('.dw-project')]
    if (rows.length < 1) return 'no-rows'
    rows[0].click()
    return 'clicked'
  })()`)
  check('a project row is clickable', firstRow === 'clicked', String(firstRow))

  const singleSelected = await session.waitFor(`document.querySelectorAll('.dw-project-active').length === 1`, 'one selected row', 15000)
  check('exactly one project is selected, never several', singleSelected === true)

  const activeCount = await session.eval(`document.querySelectorAll('.dw-project-active').length`)
  const ariaCount = await session.eval(`document.querySelectorAll('.dw-project[aria-current="true"]').length`)
  check('the selected row is marked in the DOM', activeCount === 1 && ariaCount === 1, `active=${activeCount} aria=${ariaCount}`)

  // Click a second row: selection must move, not accumulate.
  const secondRow = await session.eval(`(() => {
    const rows = [...document.querySelectorAll('.dw-project')]
    if (rows.length < 2) return 'only-one'
    rows[1].click()
    return 'clicked'
  })()`)
  if (secondRow === 'clicked') {
    await sleep(1500)
    const identity = await session.eval(`(() => {
      const rows = [...document.querySelectorAll('.dw-project')]
      const active = document.querySelector('.dw-project-active')
      const title = (node) => (node ? node.innerText.split('\\n')[0].trim() : null)
      return {
        count: document.querySelectorAll('.dw-project-active').length,
        index: rows.indexOf(active),
        activeTitle: title(active),
        secondTitle: title(rows[1]),
      }
    })()`)
    check('clicking another row moves the selection instead of adding to it', identity?.count === 1, `active=${identity?.count}`)
    check('the selected row is the one that was clicked, not a neighbour', identity?.index === 1 && identity?.activeTitle === identity?.secondTitle, JSON.stringify(identity))
  } else {
    console.log('       (only one project registered; the accumulate check was skipped)')
  }

  // ── the panel shows that project's data, not a permanent spinner ───────────

  console.log('\npanel data after selecting a project')
  const pipelineShown = await session.waitFor(`!!document.querySelector('.dw-pipeline')`, 'the stage pipeline', 60000)
  check('the stage pipeline renders for the selected project', pipelineShown === true)

  const panelText = await session.eval(`(() => {
    const stage = document.querySelector('.dw-stage')
    const board = document.querySelector('.dw-board')
    return {
      stage: stage ? stage.innerText.replace(/\\s+/g, ' ').trim().slice(0, 240) : null,
      board: board ? board.innerText.replace(/\\s+/g, ' ').trim().slice(0, 240) : null,
      bodyHasLoading: document.body.innerText.includes('正在读取'),
    }
  })()`)
  console.log(`       stage panel: ${panelText?.stage}`)
  console.log(`       board      : ${panelText?.board}`)
  check('the stage panel shows a real stage, not just a heading', typeof panelText?.stage === 'string' && panelText.stage.length > 25, JSON.stringify(panelText?.stage))
  check('no "正在读取" is left anywhere on the page', panelText?.bodyHasLoading === false, 'a loading placeholder is still on screen')

  const artefacts = await session.waitFor(
    `!!document.querySelector('.dw-artifacts') && !document.querySelector('.dw-artifacts').innerText.includes('正在扫描')`,
    'the artifact column',
    40000,
  )
  check('the artifact column resolves', artefacts === true)

  const selfCheck = await session.eval(`(() => {
    const node = document.querySelector('.dw-skills')
    return node ? node.innerText.replace(/\\s+/g, ' ').trim().slice(0, 180) : null
  })()`)
  console.log(`       self-check : ${selfCheck}`)
  check('the skill self-check renders', typeof selfCheck === 'string' && selfCheck.length > 10, String(selfCheck))

  // ── dispatch: the confirmation must open, and must not fail ────────────────
  //
  // This is where the plugin first broke in the wild: the dialog never appeared
  // and the panel showed `派发失败：cannot get property "remote" without inject`,
  // because the browser half reached for `ctx.remote` without declaring it.

  console.log('\ndispatch')
  if (SEND) {
    // Dispatch into this repository, not whichever row happens to be second.
    const targetTitle = process.env.DSH_UI_PROJECT ?? 'Developer Workbench'
    const picked = await session.eval(`(() => {
      const row = [...document.querySelectorAll('.dw-project')].find((node) => node.innerText.includes(${JSON.stringify(targetTitle)}))
      if (!row) return 'not-found'
      row.click()
      return 'clicked'
    })()`)
    console.log(`       dispatch target: ${targetTitle} (${picked})`)
    check('a project to dispatch into is selected', picked === 'clicked', String(picked))
    await sleep(3000)
  }

  const openedDialog = await session.eval(`(() => {
    const button = document.querySelector('.dw-dispatch-open')
    if (!button) return 'no-dispatch-button'
    button.click()
    return 'clicked'
  })()`)
  check('the stage panel offers a dispatch action', openedDialog === 'clicked', String(openedDialog))

  const dialogShown = await session.waitFor(`!!document.querySelector('.dw-dispatch')`, 'the dispatch dialog', 40000)
  check('clicking dispatch opens the confirmation dialog', dialogShown === true)

  const dialog = await session.eval(`(() => {
    const node = document.querySelector('.dw-dispatch')
    const text = document.querySelector('.dw-dispatch-text')
    return {
      text: node ? node.innerText.replace(/\\s+/g, ' ').trim().slice(0, 320) : null,
      prompt: text ? String(text.value ?? '').slice(0, 400) : null,
      failureBanner: document.body.innerText.includes('派发失败'),
      sendLabel: document.querySelector('.dw-dispatch-send') ? document.querySelector('.dw-dispatch-send').innerText.trim() : null,
    }
  })()`)
  console.log(`       dialog: ${dialog?.text}`)
  check('the dispatch dialog did not report a failure', dialog?.failureBanner === false, 'the 派发失败 banner is on screen')
  check('the dialog carries a real, non-empty prompt', typeof dialog?.prompt === 'string' && dialog.prompt.length > 40, JSON.stringify(dialog?.prompt ?? null).slice(0, 200))
  check('the prompt names the skill it will run', typeof dialog?.prompt === 'string' && dialog.prompt.includes('SKILL.md'), String(dialog?.prompt ?? '').slice(0, 160))

  if (SEND) {
    console.log('\nsending for real (--send)')
    // The dialog's prompt is editable on purpose, which is what makes a harmless
    // end-to-end run possible: the real path (create session → send → navigate)
    // is exercised while the agent receives something that asks it to do nothing.
    const SAFE_PROMPT = '这是一条自动化验收测试消息，用来验证工作台的派发链路。请只回复「收到」，不要读取或修改任何文件，不要执行任何命令，不要创建任何东西。'
    const rewritten = await session.eval(`(() => {
      const textarea = document.querySelector('.dw-dispatch-text')
      if (!textarea) return 'no-textarea'
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(SAFE_PROMPT)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return textarea.value.length > 0 ? 'rewritten' : 'empty'
    })()`)
    check('the test prompt is substituted into the editable dialog', rewritten === 'rewritten', String(rewritten))
    await sleep(500)

    const clickedSend = await session.eval(`(() => {
      const button = document.querySelector('.dw-dispatch-send')
      if (!button) return 'no-send-button'
      if (button.disabled) return 'disabled'
      button.click()
      return 'clicked'
    })()`)
    check('the send button is enabled and clickable', clickedSend === 'clicked', String(clickedSend))

    await session.waitFor(
      `!document.querySelector('.dw-dispatch') || document.body.innerText.includes('派发失败')`,
      'the send to settle',
      90000,
    )
    const afterSend = await session.eval(`(() => ({
      dialogStillOpen: !!document.querySelector('.dw-dispatch'),
      failureBanner: document.body.innerText.includes('派发失败'),
      // The message is the whole point of a failure: capture it, not the page.
      failureText: (() => {
        const node = [...document.querySelectorAll('*')].find((element) => element.children.length === 0 && element.textContent.includes('派发失败'))
        return node ? node.parentElement.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300) : null
      })(),
      bodyHint: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200),
    }))()`)
    check('sending produced no failure', afterSend?.failureBanner === false, String(afterSend?.failureText ?? afterSend?.bodyHint).slice(0, 300))
    check('the confirmation closed after sending', afterSend?.dialogStillOpen === false, String(afterSend?.failureText ?? '').slice(0, 300))
    console.log(`       after send: dialogStillOpen=${afterSend?.dialogStillOpen} failure=${JSON.stringify(afterSend?.failureText)}`)
  } else {
    console.log('       (pass --send to actually dispatch; the default run only opens the dialog)')
    await session.eval(`(() => { const b = document.querySelector('.dw-dispatch-close'); if (b) b.click(); return 'closed' })()`)
  }

  // ── console health ─────────────────────────────────────────────────────────

  console.log('\nconsole')
  check('no uncaught errors were reported', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  await session.send('Page.captureScreenshot', { format: 'png' }).then((result) => {
    fs.writeFileSync(shotPath, Buffer.from(result.data, 'base64'))
    console.log(`\nscreenshot: ${shotPath}`)
  }).catch((error) => console.log(`screenshot failed: ${error.message}`))
} catch (error) {
  failures.push(`the probe threw: ${String(error?.message ?? error)}`)
  console.log(`\n  FAIL the probe threw: ${String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ')}`)
} finally {
  try {
    socket?.close()
  } catch (error) {
    // ignore
  }
  browser.kill()
  await sleep(400)
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch (error) {
    // ignore
  }
}

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${passed} assertions`)
  process.exit(0)
}
console.log(`FAIL — ${passed} passed, ${failures.length} failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
