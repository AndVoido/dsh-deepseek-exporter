/**
 * dsh-deepseek-exporter — export DSH sessions into the DeepSeek official
 * conversation export format (v3 ZIP).
 *
 * Two surfaces, one engine:
 *   - Web / Host:  GET  /deepseek-export/api/sessions
 *                  POST /deepseek-export/api/export
 *   - dsh-go native panel `deepseek-export`: pick sessions, export, see result.
 *
 * Both read sessions through the host's own `sessionPersistence` service and
 * convert with ./export-core.js. Nothing here reads a session log by hand.
 */
import { lstat, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exportSessions, listSessions, titleFromEvents, dshHome } from './export-core.js'

export const name = 'dsh-deepseek-exporter'

/** The plugin waits for the session store; without it there is nothing to export. */
export const inject = ['sessionPersistence']

const ROUTE_SESSIONS = '/deepseek-export/api/sessions'
const ROUTE_EXPORT = '/deepseek-export/api/export'
const ROUTE_PREFS = '/deepseek-export/api/prefs'
const MAX_BODY_BYTES = 256 * 1024
const MAX_SELECTED = 64
/** How many session logs one listing pass is willing to open for titles/counts. */
const TITLE_BUDGET = 80

let persistence = null
let hostCtx = null
let notifyPersistence = null
const persistenceReady = new Promise((resolve) => { notifyPersistence = resolve })
let logger = null
let panelEmit = null
let revision = 0

/** id -> { title, messages, updatedAt, images }; refilled lazily, never persisted. */
const summaryCache = new Map()

function bump() {
  revision += 1
  try {
    panelEmit?.({ rev: revision })
  } catch { /* the panel is not open */ }
}

function warn(message) {
  try {
    logger?.warn(`deepseek-exporter: ${message}`)
  } catch { /* logging never breaks an export */ }
}

// ---------------------------------------------------------------------------
// Session summaries (title / message count) for both surfaces
// ---------------------------------------------------------------------------

/**
 * Count what the exporter will actually emit: one USER message per human turn
 * with content, one ASSISTANT message per assistant turn.
 */
function countMessages(events) {
  const userKinds = new Set(['user'])
  let messages = 0
  let lastTurn
  let hasReply = false
  for (const event of events) {
    if (event?.surfaceOp !== 'append') continue
    if (event.type === 'user/message') {
      if (!userKinds.has(event.data?.source?.kind ?? 'user')) continue
      const parts = Array.isArray(event.data?.content) ? event.data.content : []
      const hasContent = parts.some(
        (part) => (part?.type === 'text' && String(part.text ?? '').trim() !== '')
          || part?.type === 'image'
          || part?.type === 'file',
      )
      if (hasContent) {
        if (hasReply) {
          messages += 1
          hasReply = false
        }
        messages += 1
      }
    } else if (event.type === 'assistant/message') {
      const turn = event.data?.turn
      if (hasReply && turn !== lastTurn) {
        messages += 1
        hasReply = false
      }
      const parts = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      if (parts.some((part) => part?.type === 'text' || part?.type === 'reasoning' || part?.type === 'image' || part?.type === 'file')) {
        hasReply = true
        lastTurn = turn
      }
    }
  }
  if (hasReply) messages += 1
  return messages
}

/** Newest event timestamp in a log, or null when the log carries none. */
function lastEventTime(events) {
  let newest = null
  for (const event of events) {
    if (Number.isFinite(event?.time) && (newest === null || event.time > newest)) newest = event.time
  }
  return newest
}

/**
 * The injected store, waiting briefly for it on the first call: `ctx.inject`
 * fires when the service appears, which can be after the first HTTP request or
 * the first panel open. A store that never arrives is an error, never a silent
 * fallback to some other root.
 */
async function requirePersistence(timeoutMs = 15_000) {
  if (persistence) return persistence
  // `ctx.inject` fires when the service appears; also poll, because the first
  // HTTP request or panel open can race the injection callback.
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (persistence) return persistence
    try {
      const direct = hostCtx?.get?.('sessionPersistence')
      if (direct) {
        persistence = direct
        notifyPersistence?.()
        return persistence
      }
    } catch { /* the context is not ready yet */ }
    let timer
    try {
      await Promise.race([
        persistenceReady,
        new Promise((resolve) => { timer = setTimeout(resolve, 200) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  if (!persistence) throw new Error('sessionPersistence service is not available')
  return persistence
}

/** Read one session's events without keeping the handle open. */
async function readEvents(sessionId) {
  const store = await requirePersistence()
  const handle = await store.open(sessionId, 'read')
  try {
    const slice = await handle.read()
    return slice.events
  } finally {
    await handle.close()
  }
}

/**
 * List sessions with the metadata both surfaces show. Headers come from the
 * store (cheap); titles and counts need the log, so they are cached per id and
 * only the newest {@link TITLE_BUDGET} logs are opened on a cache miss.
 */
async function sessionRows({ refresh = false } = {}) {
  const headers = await listSessions(await requirePersistence())
  const rows = []
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]
    let cached = summaryCache.get(header.id)
    if (refresh || cached === undefined) {
      if (index < TITLE_BUDGET) {
        try {
          const events = await readEvents(header.id)
          cached = {
            title: titleFromEvents(events),
            messages: countMessages(events),
            events: events.length,
            updatedAt: lastEventTime(events),
          }
        } catch (error) {
          warn(`cannot read session metadata (${error?.code ?? "error"}) ${error?.name}: ${String(error?.message).slice(0,160)}`)
          cached = { title: null, messages: null, events: null, updatedAt: null }
        }
      } else {
        cached = { title: null, messages: null, events: null, updatedAt: null }
      }
      summaryCache.set(header.id, cached)
    }
    rows.push({
      id: header.id,
      title: cached.title?.trim() ? cached.title : null,
      messages: cached.messages,
      events: cached.events,
      createdAt: header.createdAt,
      updatedAt: cached.updatedAt ?? header.createdAt,
      projectDir: header.cwd ?? null,
      parentSession: header.parentSession ?? null,
      origin: header.origin ?? null,
      sizeBytes: header.sizeBytes ?? null,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Export target
// ---------------------------------------------------------------------------

function stampName() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  // Milliseconds: two exports in the same second must not overwrite each other.
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `deepseek-export-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${ms}`
}

/**
 * Where the ZIP goes. The phone's shared Download folder is the product answer;
 * a host without it (or without write access) keeps the file in DSH's own cache
 * and reports that path instead of failing.
 */
/** The product default: the phone's shared Download folder, one subfolder deep. */
const DEFAULT_OUT_DIR = '/sdcard/Download/DSH-Go'
/** The only tree the user may point an export at. Everything else falls back. */
const OUT_ROOT = '/sdcard'
const OUT_DIR_MAX = 200
const PREF_FILE = () => join(dshHome(), 'dsh-go', 'deepseek-exporter-prefs.json')

/**
 * The user's export folder, as the panel shows it. Kept here (not in the panel
 * state) because an export can be triggered while the panel is closed.
 */
let outDir = DEFAULT_OUT_DIR
let outDirWarning = null
/**
 * What the panel's text box holds while the person is still typing. Kept apart
 * from `outDir` so a half-typed path can never be the one an export writes to,
 * and so a keystroke never raises a warning.
 */
let outDirDraft = null

function outPrefsPath() {
  try {
    return PREF_FILE()
  } catch {
    return null
  }
}

/** Read the remembered folder once at startup; a broken file just keeps the default. */
async function loadPrefs() {
  const path = outPrefsPath()
  if (path === null) return
  try {
    const text = await readFile(path, 'utf8')
    if (text.length > 4096) return
    const parsed = JSON.parse(text)
    const saved = parsed?.outDir
    if (typeof saved !== 'string') return
    const checked = checkOutDir(saved)
    if (checked.dir === null) {
      // The remembered folder is no longer legal; keep the default silently.
      warn(`stored export folder rejected (${checked.reason})`)
      return
    }
    outDir = checked.dir
    outDirDraft = checked.dir
  } catch { /* no prefs yet, or unreadable: the default stands */ }
}

/** Remember the folder for the next run. Best effort: never breaks an export. */
async function savePrefs() {
  const path = outPrefsPath()
  if (path === null) return
  try {
    await mkdir(join(dshHome(), 'dsh-go'), { recursive: true })
    await writeFile(path, `${JSON.stringify({ outDir }, null, 2)}\n`, 'utf8')
  } catch (error) {
    warn(`cannot remember the export folder (${error?.code ?? 'error'})`)
  }
}

/**
 * Decide whether a typed folder may receive an export.
 *
 * Refused, all falling back to the default with a reason:
 *   - empty / not a string / absurdly long;
 *   - a `..` segment anywhere, or a NUL byte;
 *   - anything not under `/sdcard/` (so `/`, `/root`, `/data` never qualify);
 *   - a path whose nearest existing ancestor resolves outside `/sdcard` through a
 *     symlink (lexical checks alone are not enough on proot).
 *
 * @param raw - what the panel sent.
 * @returns `{ dir, reason }`; `dir` is null when the path is refused.
 */
function checkOutDir(raw) {
  if (typeof raw !== 'string') return { dir: null, reason: 'not-string' }
  const text = raw.trim()
  if (text === '') return { dir: null, reason: 'empty' }
  if (text.length > OUT_DIR_MAX) return { dir: null, reason: 'too-long' }
  if (text.includes('\0')) return { dir: null, reason: 'nul-byte' }
  // Windows-style separators would sneak past a POSIX-only check.
  if (text.includes('\\')) return { dir: null, reason: 'backslash' }
  if (!text.startsWith('/')) return { dir: null, reason: 'not-absolute' }
  const parts = text.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) return { dir: null, reason: 'parent-ref' }
  if (parts[0] !== 'sdcard') return { dir: null, reason: 'outside-sdcard' }
  if (parts.length < 2) return { dir: null, reason: 'outside-sdcard' }
  const cleaned = `/${parts.join('/')}`
  if (cleaned === OUT_ROOT) return { dir: null, reason: 'outside-sdcard' }
  return { dir: cleaned, reason: null }
}

/** Whether this host has the shared storage tree at all (desktop hosts do not). */
async function hasSharedStorage() {
  try {
    await realpath(OUT_ROOT)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a candidate folder against the real filesystem, following symlinks on
 * the deepest existing ancestor. A folder that would land outside `/sdcard` is
 * refused, which is what stops a symlinked subfolder from escaping the sandbox.
 * @param dir - an already lexically-checked absolute path.
 * @returns the resolved path, or null when it escapes or cannot be resolved.
 */
async function resolveInsideRoot(dir) {
  let root
  try {
    root = await realpath(OUT_ROOT)
  } catch {
    return null
  }
  let probe = dir
  let tail = []
  // Walk up until something exists; then re-append the missing segments.
  for (let depth = 0; depth < 32; depth += 1) {
    let info = null
    try {
      info = await lstat(probe)
    } catch { /* missing: keep walking up */ }
    if (info !== null) {
      let real
      try {
        real = await realpath(probe)
      } catch {
        return null
      }
      if (real !== root && !real.startsWith(`${root}/`)) return null
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    }
    const slash = probe.lastIndexOf('/')
    if (slash <= 0) return null
    tail.push(probe.slice(slash + 1))
    probe = probe.slice(0, slash)
  }
  return null
}

/**
 * The folder to write into, plus the warning to show. The typed folder wins when
 * it passes every check; otherwise the default does, degraded to DSH's own cache
 * on a host without shared storage (so the web/disk answer still works there).
 * @param requested - the folder the caller asked for; `outDir` when omitted.
 * @returns `{ dir, usersDir, warning }`.
 */
async function resolveExportDir(requested) {
  const wanted = requested === undefined ? outDir : requested
  const checked = checkOutDir(wanted)
  let warning = null
  if (checked.dir === null) {
    warning = checked.reason === 'empty'
      ? 'empty'
      : checked.reason
  } else {
    const real = await resolveInsideRoot(checked.dir)
    // A host with no `/sdcard` at all is not a folder that "escaped the root";
    // say what is really wrong so the panel does not blame the typed path.
    if (real === null) warning = (await hasSharedStorage()) ? 'escapes-sdcard' : 'no-shared-storage'
    else return { dir: real, usersDir: checked.dir, warning: null }
  }
  // Fallback 1: the shared Download folder, if this host has it.
  const fallback = await resolveInsideRoot(DEFAULT_OUT_DIR)
  if (fallback !== null) {
    return { dir: fallback, usersDir: DEFAULT_OUT_DIR, warning: warning ?? 'invalid-path' }
  }
  // Fallback 2: DSH's own cache — no /sdcard at all (desktop, remote host).
  return { dir: join(dshHome(), 'cache', 'deepseek-export'), usersDir: null, warning: warning ?? 'no-shared-storage' }
}

/**
 * Write the archive and report it, the phone-panel answer.
 * @param sessionIds - validated ids to export.
 * @param requested - optional folder override, already validated by the caller.
 * @returns the export result carrying the on-disk path and any folder warning.
 */
async function exportToDisk(sessionIds, requested) {
  const chosen = await resolveExportDir(requested)
  let lastError
  // On a host without /sdcard the chosen folder *is* the cache folder; listing it
  // twice would run the whole conversion again just to fail the same way.
  const cacheDir = join(dshHome(), 'cache', 'deepseek-export')
  const attempts = chosen.dir === cacheDir ? [chosen.dir] : [chosen.dir, cacheDir]
  for (const dir of attempts) {
    try {
      await mkdir(dir, { recursive: true })
      // Drop archives older than a day so the shared folder does not fill up.
      const keep = Date.now() - 24 * 60 * 60 * 1000
      try {
        for (const entry of await readdir(dir)) {
          if (!entry.startsWith('deepseek-export-') || !entry.endsWith('.zip')) continue
          const path = join(dir, entry)
          const info = await stat(path)
          if (info.mtimeMs < keep) await unlink(path)
        }
      } catch { /* pruning is best effort */ }
      const outFile = join(dir, `${stampName()}.zip`)
      const result = await exportSessions({ outFile, sessionIds, service: await requirePersistence() })
      const degraded = dir !== chosen.dir
      return {
        ...result,
        outFile,
        outDir: dir,
        // The folder the person asked for, so the panel can echo it back.
        requestedDir: chosen.usersDir ?? dir,
        dirWarning: degraded ? 'unwritable-fallback' : chosen.warning,
      }
    } catch (error) {
      lastError = error
      warn(`cannot write the export to ${dir} (${error?.code ?? 'error'})`)
    }
  }
  throw lastError ?? new Error('no writable export directory')
}

/**
 * Build the archive in memory for the browser download. Nothing is written: the
 * web client owns the file, so a shared-storage failure can never break it.
 * @param sessionIds - validated ids to export.
 * @returns the export result carrying `archive` (a Buffer) and `outFile: null`.
 */
async function exportToBuffer(sessionIds) {
  return exportSessions({ buffer: true, sessionIds, service: await requirePersistence() })
}

/**
 * Browser download filename for one export, safe for a Content-Disposition header.
 * @param when - the moment the archive was stamped.
 * @returns a plain ASCII `.zip` name.
 */
function downloadName(when = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `deepseek-export-${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}.zip`
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

/**
 * Who may call these routes: the owner only. From 0.2.2-rc.3 the web server hands
 * the handler an admitted Peer; on rc.1 it passes none and the route applies the
 * same check itself through the connection service. No connection service means
 * 503 — never a silent pass-through.
 */
function admission(ctx, req, peer) {
  if (peer !== undefined && peer !== null) {
    return peer.principal?.kind === 'owner' ? null : 403
  }
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    connection = undefined
  }
  if (!connection || typeof connection.admit !== 'function') return 503
  let result
  try {
    result = connection.admit(req)
  } catch {
    return 503
  }
  if (result && result.peer) return result.peer.principal?.kind === 'owner' ? null : 403
  return Number.isInteger(result?.rejection) ? result.rejection : 401
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const type = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (type !== 'application/json') return { error: { status: 415, code: 'unsupported-media-type' } }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return { error: { status: 413, code: 'too-large' } }
    chunks.push(chunk)
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return { error: { status: 400, code: 'bad-json' } }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: { status: 400, code: 'bad-json' } }
  }
  return { body }
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return null
  const ids = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return null
    if (!ids.includes(item)) ids.push(item)
  }
  if (ids.length === 0 || ids.length > MAX_SELECTED) return null
  return ids
}

function sessionsRoute(ctx) {
  return {
    kind: 'exact',
    auth: 'required',
    path: ROUTE_SESSIONS,
    handler: async (req, res, peer) => {
      try {
        const refused = admission(ctx, req, peer)
        if (refused !== null) {
          return sendJson(res, refused, { code: refused === 403 ? 'forbidden' : 'owner-access-required' })
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { code: 'method-not-allowed' }, { allow: 'GET, HEAD' })
        }
        const refresh = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('refresh') === '1'
        sendJson(res, 200, { sessions: await sessionRows({ refresh }) })
      } catch (error) {
        warn(`listing failed (${error?.code ?? 'error'})`)
        if (!res.headersSent) sendJson(res, 500, { code: 'listing-failed' })
        else res.end()
      }
    },
  }
}

/**
 * How the caller wants the archive delivered:
 *   - `download` — the ZIP bytes, streamed back for the browser download manager.
 *   - `disk`     — the ZIP written to Download/DSH-Go, path reported as JSON.
 * `?download=1` opts into the browser answer; anything else keeps the phone
 * panel's on-disk behaviour, so the existing native panel is untouched.
 * @param req - the incoming request.
 * @returns the negotiated delivery mode.
 */
function deliveryMode(req) {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  if (url.searchParams.get('download') === '1') return 'download'
  const accept = String(req.headers?.accept ?? '').toLowerCase()
  // An `Accept` that names the ZIP and not JSON is a browser download too.
  if (accept.includes('application/zip') && !accept.includes('application/json')) return 'download'
  return 'disk'
}

/**
 * The folder the panel and the web client both read and write, so the two
 * surfaces never disagree. GET answers the remembered folder, the presets to
 * offer and the default; POST validates with the same {@link checkOutDir} the
 * native panel uses and remembers the result. Nothing here widens the rule that
 * an export may only land under /sdcard.
 */
function prefsRoute(ctx) {
  return {
    kind: 'exact',
    auth: 'required',
    path: ROUTE_PREFS,
    handler: async (req, res, peer) => {
      try {
        const refused = admission(ctx, req, peer)
        if (refused !== null) {
          return sendJson(res, refused, { code: refused === 403 ? 'forbidden' : 'owner-access-required' })
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          return sendJson(res, 200, {
            outDir,
            defaultOutDir: DEFAULT_OUT_DIR,
            maxLength: OUT_DIR_MAX,
            presets: OUT_DIR_PRESETS.map((preset) => ({ label: preset.label, value: preset.value })),
          })
        }
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'method-not-allowed' }, { allow: 'GET, HEAD, POST' })
        }
        const parsed = await readJsonBody(req)
        if (parsed.error) return sendJson(res, parsed.error.status, { code: parsed.error.code })
        const checked = checkOutDir(parsed.body.outDir)
        if (checked.dir === null) {
          return sendJson(res, 400, {
            code: 'invalid-out-dir',
            reason: checked.reason,
            // Human words, so the browser client never has to own a copy.
            message: outDirReasonText(checked.reason, false),
          })
        }
        outDir = checked.dir
        outDirWarning = null
        void savePrefs()
        bump()
        sendJson(res, 200, { ok: true, outDir })
      } catch (error) {
        warn(`saving the export folder failed (${error?.code ?? 'error'})`)
        if (!res.headersSent) sendJson(res, 500, { code: 'prefs-failed' })
        else res.end()
      }
    },
  }
}

function exportRoute(ctx) {
  return {
    kind: 'exact',
    auth: 'required',
    path: ROUTE_EXPORT,
    handler: async (req, res, peer) => {
      try {
        const refused = admission(ctx, req, peer)
        if (refused !== null) {
          return sendJson(res, refused, { code: refused === 403 ? 'forbidden' : 'owner-access-required' })
        }
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'method-not-allowed' }, { allow: 'POST' })
        }
        const parsed = await readJsonBody(req)
        if (parsed.error) return sendJson(res, parsed.error.status, { code: parsed.error.code })
        const ids = normalizeIds(parsed.body.sessionIds)
        if (ids === null) {
          return sendJson(res, 400, { code: 'invalid-session-ids', message: `need 1..${MAX_SELECTED} session ids` })
        }
        // An explicit folder wins for this one call; it goes through the same
        // check as the panel, and a refused one is reported instead of being
        // silently swapped for another folder the person did not ask for.
        let target
        if (parsed.body.outDir !== undefined && parsed.body.outDir !== null && parsed.body.outDir !== '') {
          const checked = checkOutDir(parsed.body.outDir)
          if (checked.dir === null) {
            return sendJson(res, 400, {
              code: 'invalid-out-dir',
              reason: checked.reason,
              message: outDirReasonText(checked.reason, false),
            })
          }
          target = checked.dir
        }
        if (deliveryMode(req) === 'download') {
          const download = await exportToBuffer(ids)
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-length': String(download.archive.length),
            'content-disposition': `attachment; filename="${downloadName()}"`,
            'cache-control': 'no-store',
          })
          res.end(download.archive)
          return
        }
        const result = await exportToDisk(ids, target)
        sendJson(res, 200, {
          sessions: result.sessions,
          messages: result.messages,
          images: result.images,
          imagesMissing: result.imagesMissing,
          bytes: result.bytes,
          path: result.outFile,
          outDir: result.outDir,
          requestedDir: result.requestedDir ?? null,
          dirWarning: result.dirWarning ?? null,
          ids: result.ids,
          missingSessions: result.missingSessions,
        })
      } catch (error) {
        const message = String(error?.message ?? error)
        const missing = /no DSH session to export/.test(message)
        warn(`export failed (${error?.code ?? 'error'})`)
        if (!res.headersSent) {
          sendJson(res, missing ? 400 : 500, {
            code: missing ? 'no-sessions' : 'export-failed',
            message: missing ? 'selected sessions are no longer available' : 'export failed',
          })
        } else res.end()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// dsh-go native panel
// ---------------------------------------------------------------------------

const PAGE_SIZE = 8

const panelState = {
  rows: [],
  selected: new Set(),
  page: 0,
  loading: false,
  exporting: false,
  result: null,
  /** A listing failure ("cannot read the session store"). */
  error: null,
  /** A failed export, kept apart so it is not reported as a listing problem. */
  exportError: null,
  loadedAt: 0,
}

/** Preset folders offered as buttons. Each value must pass {@link checkOutDir}. */
const OUT_DIR_PRESETS = [
  { label: 'Download/DSH-Go', value: '/sdcard/Download/DSH-Go' },
  { label: 'Download', value: '/sdcard/Download' },
  { label: 'DCIM', value: '/sdcard/DCIM' },
  { label: 'Documents', value: '/sdcard/Documents' },
]

/** How many buttons one `actions` row holds (the view schema's own limit). */
const RESERVED_ACTIONS = 4

/** Human words for each refusal reason, so the toast is never a bare code. */
function outDirReasonText(reason, isEn) {
  const zh = {
    'empty': '位置为空，已用默认位置',
    'not-string': '位置不是文字，已用默认位置',
    'too-long': '位置太长，已用默认位置',
    'nul-byte': '位置含非法字符，已用默认位置',
    'backslash': '位置含非法字符，已用默认位置',
    'not-absolute': '请填以 / 开头的绝对路径',
    'parent-ref': '位置不能含 ..',
    'outside-sdcard': '只能写到 /sdcard 下面',
    'escapes-sdcard': '这个位置指向 /sdcard 之外，已拒绝',
    'no-shared-storage': '这台主机没有共享存储，已写到本机缓存',
    'invalid-path': '位置不可用，已用默认位置',
    'unwritable-fallback': '这个位置写不进去，已换到默认位置',
  }
  const en = {
    'empty': 'Empty folder, using the default',
    'not-string': 'Folder is not text, using the default',
    'too-long': 'Folder is too long, using the default',
    'nul-byte': 'Folder has an illegal character, using the default',
    'backslash': 'Folder has an illegal character, using the default',
    'not-absolute': 'Use an absolute path starting with /',
    'parent-ref': 'The folder cannot contain ..',
    'outside-sdcard': 'Only folders under /sdcard are allowed',
    'escapes-sdcard': 'That folder points outside /sdcard and was refused',
    'no-shared-storage': 'No shared storage here; wrote to the local cache',
    'invalid-path': 'That folder is unusable, using the default',
    'unwritable-fallback': 'Could not write there, moved to the default',
  }
  return (isEn ? en : zh)[reason] ?? (isEn ? 'Folder rejected, using the default' : '位置被拒绝，已用默认位置')
}

/**
 * Read the value out of a control's invoke payload. The App may send the bare
 * value, `{ value }` or `{ values: [...] }` depending on the control kind, so
 * the shape itself decides instead of guessing one.
 */
function controlText(event) {
  const raw = event?.value
  if (typeof raw === 'string') return raw
  if (raw === null || typeof raw !== 'object') return null
  const inner = raw.value ?? raw.values ?? raw.text ?? raw.selected ?? raw.data?.outDirDraft ?? raw.data?.outDir ?? raw.outDirDraft ?? raw.outDir
  if (typeof inner === 'string') return inner
  if (Array.isArray(inner)) {
    const first = inner.find((item) => typeof item === 'string')
    return typeof first === 'string' ? first : null
  }
  return null
}

function localeIsEn(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en')
}

function pageRows() {
  const start = panelState.page * PAGE_SIZE
  return panelState.rows.slice(start, start + PAGE_SIZE)
}

function pageCount() {
  return Math.max(1, Math.ceil(panelState.rows.length / PAGE_SIZE))
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One row: title, message count, date. A session with no title shows its id tail. */
function rowLabel(row, isEn) {
  if (row.title) return row.title
  return isEn ? `Untitled ${row.id.slice(-8)}` : `未命名 ${row.id.slice(-8)}`
}

function rowSubtitle(row, isEn) {
  const parts = []
  // Subagent sessions are noise for a DeepSeek export; say so on the row.
  if (row.origin === 'subagent') parts.push(isEn ? 'subagent' : '子代理')
  parts.push(row.messages === null ? (isEn ? 'messages: —' : '消息数：—') : (isEn ? `${row.messages} messages` : `${row.messages} 条消息`))
  parts.push(formatDate(row.updatedAt))
  if (row.projectDir) parts.push(row.projectDir)
  return parts.join(' · ')
}

async function refreshRows({ force = false } = {}) {
  if (panelState.loading) return
  panelState.loading = true
  panelState.error = null
  try {
    panelState.rows = await sessionRows({ refresh: force })
    const live = new Set(panelState.rows.map((row) => row.id))
    for (const id of [...panelState.selected]) if (!live.has(id)) panelState.selected.delete(id)
    if (panelState.page >= pageCount()) panelState.page = Math.max(0, pageCount() - 1)
    panelState.loadedAt = Date.now()
  } catch (error) {
    panelState.error = String(error?.code ?? error?.message ?? 'error')
  } finally {
    panelState.loading = false
  }
}

function panelView(_scope, caps) {
  const isEn = localeIsEn(caps?.locale)
  const rows = pageRows()
  // `textField` is a v2-only control. An App that does not list it gets the old
  // v1 panel with the folder fixed at the default, instead of a panel that fails
  // to draw; the export itself is identical.
  const canPickFolder = caps?.components === undefined || (Array.isArray(caps.components) && caps.components.includes('textField'))
  const children = [
    {
      type: 'callout',
      tone: 'info',
      text: isEn
        ? 'Pick sessions, then export. The ZIP uses the DeepSeek official v3 layout and is written to the folder below.'
        : '勾选会话后导出。ZIP 使用 DeepSeek 官方 v3 结构，写入下面选定的位置。',
    },
    {
      type: 'keyValue',
      items: [
        [isEn ? 'Sessions' : '会话总数', String(panelState.rows.length)],
        [isEn ? 'Selected' : '已选', String(panelState.selected.size)],
        [isEn ? 'Page' : '页码', `${panelState.page + 1} / ${pageCount()}`],
      ],
    },
  ]

  if (panelState.error) {
    children.push({ type: 'callout', tone: 'bad', text: isEn ? `Cannot list sessions (${panelState.error})` : `无法列出会话（${panelState.error}）` })
  }
  if (panelState.exportError) {
    children.push({ type: 'callout', tone: 'bad', text: isEn ? `Export failed (${panelState.exportError})` : `导出失败（${panelState.exportError}）` })
  }

  if (rows.length === 0) {
    children.push({
      type: 'text',
      tone: 'muted',
      text: panelState.loading
        ? (isEn ? 'Loading sessions…' : '正在读取会话…')
        : (isEn ? 'No sessions found.' : '没有找到会话。'),
    })
  } else {
    children.push({
      type: 'options',
      id: 'toggle',
      multi: true,
      options: rows.map((row) => ({
        label: rowLabel(row, isEn).slice(0, 40),
        description: rowSubtitle(row, isEn).slice(0, 80),
        value: row.id,
      })),
      // Bound to the pushed data, so the App draws the checked state itself
      // instead of waiting for the engine to echo it back.
      selected: { $: 'data.selected' },
    })
    children.push({
      type: 'actions',
      items: [
        { label: isEn ? 'Select page' : '选中本页', action: 'selectPage' },
        { label: isEn ? 'Real chats only' : '只选真实对话', action: 'selectReal' },
        { label: isEn ? 'Clear' : '清空', action: 'clearAll' },
      ],
    })
  }

  if (pageCount() > 1) {
    children.push({
      type: 'actions',
      items: [
        { label: isEn ? 'Previous' : '上一页', action: 'pagePrev' },
        { label: isEn ? 'Next' : '下一页', action: 'pageNext' },
      ],
    })
  }

  // ---- where the ZIP goes ------------------------------------------------
  // dsh-go has no "pick a folder to save" surface (pickFile only reads), so the
  // folder is typed here or tapped from the presets.
  //
  // No `form` wrapper: on the phone its label and submit row crowded the text
  // box and clipped it at the top. A plain textField plus an explicit action is
  // the same behaviour with a layout the panel controls.
  //
  // Presets go through `actions`, not `chips`: `chips` is an inputV2 control and
  // the schema makes an inputV2 control interactive only "when bind is present"
  // (view.schema.json, $defs.inputV2) — with no bind the chips drew but a tap
  // invoked nothing, which is why only the pre-selected one ever looked usable.
  // An `actions` button always sends its `action` back to us.
  children.push({ type: 'divider', size: 'S' })
  children.push({
    type: 'text',
    style: { size: 'subtitle', weight: 'semibold' },
    text: isEn ? 'Export folder' : '导出位置',
  })
  if (canPickFolder) {
    children.push({
      type: 'textField',
      label: isEn ? 'Folder (under /sdcard)' : '文件夹（/sdcard 下）',
      // Bound to a draft, never to the committed folder: a half-typed path must
      // not be the one an export writes to.
      bind: 'data.outDirDraft',
      value: outDirDraft ?? outDir,
      placeholder: DEFAULT_OUT_DIR,
      maxLength: OUT_DIR_MAX,
      onChange: 'outDirTyping',
    })
    children.push({
      type: 'actions',
      items: [{ label: isEn ? 'Use this folder' : '使用这个位置', action: 'outDirSet' }],
    })
  }
  // One button per preset. `actions` holds at most four (view.schema.json's
  // limit), so the presets are split into groups of four rather than dropped.
  children.push({
    type: 'text',
    tone: 'muted',
    text: isEn ? 'Presets' : '常用位置',
  })
  for (let start = 0; start < OUT_DIR_PRESETS.length; start += RESERVED_ACTIONS) {
    children.push({
      type: 'actions',
      items: OUT_DIR_PRESETS.slice(start, start + RESERVED_ACTIONS).map((preset, offset) => ({
        label: preset.label,
        // The index, not the path: the action id stays short and the preset
        // table stays the single source of truth for what a preset means.
        action: `preset${start + offset}`,
      })),
    })
  }
  children.push({
    type: 'keyValue',
    items: [[isEn ? 'Writing to' : '当前写入', outDir]],
  })
  if (outDirWarning) {
    children.push({ type: 'callout', tone: 'warn', text: outDirReasonText(outDirWarning, isEn) })
  }

  children.push({
    type: 'actions',
    items: [
      { label: isEn ? 'Export selected' : '导出选中', action: 'export' },
      { label: isEn ? 'Refresh' : '刷新列表', action: 'refresh' },
    ],
  })

  if (panelState.exporting) {
    children.push({ type: 'progress', value: 0, max: 1, label: isEn ? 'Exporting' : '正在导出', caption: isEn ? 'reading sessions and images' : '读取会话与图片' })
  }

  const result = panelState.result
  if (result) {
    const missing = result.imagesMissing ?? 0
    children.push({
      type: 'callout',
      tone: 'good',
      text: isEn
        ? `Exported ${result.sessions} session(s), ${result.messages} messages, ${formatBytes(result.bytes)}`
        : `已导出 ${result.sessions} 个会话、${result.messages} 条消息、${formatBytes(result.bytes)}`,
    })
    if (missing > 0) {
      children.push({
        type: 'callout',
        tone: 'warn',
        text: isEn ? `${missing} image(s) had no stored bytes and were left as placeholders.` : `${missing} 张图片没有可读字节，只写了占位。`,
      })
    }
    if (Array.isArray(result.missingSessions) && result.missingSessions.length > 0) {
      children.push({
        type: 'callout',
        tone: 'warn',
        text: isEn
          ? `${result.missingSessions.length} selected session(s) no longer exist and were skipped.`
          : `${result.missingSessions.length} 个所选会话已不存在，已跳过。`,
      })
    }
    children.push({ type: 'keyValue', items: [[isEn ? 'Saved to' : '保存位置', result.outFile], [isEn ? 'Sessions' : '本次会话', String(result.sessions)]] })
    if (result.dirWarning) {
      children.push({ type: 'callout', tone: 'warn', text: outDirReasonText(result.dirWarning, isEn) })
    }
  }

  if (panelState.selected.size === 0 && !panelState.result) {
    children.push({ type: 'text', tone: 'muted', text: isEn ? 'Nothing selected yet.' : '还没有选中任何会话。' })
  }

  // v2 only when a v2-only control is actually in the tree; an old App keeps the
  // v1 rendering path it knows.
  if (!canPickFolder) return { type: 'stack', title: isEn ? 'Export DeepSeek Sessions' : '导出 DeepSeek 会话', children }
  return { v: 2, type: 'stack', title: isEn ? 'Export DeepSeek Sessions' : '导出 DeepSeek 会话', children }
}

function panelData() {
  return {
    rev: revision,
    outDir,
    // The text box binds here. It follows the committed folder until the person
    // types, then follows the typing — so the box never shows a stale path and
    // never becomes the folder an export uses.
    outDirDraft: outDirDraft ?? outDir,
    outDirWarning,
    selected: [...panelState.selected],
    sessions: panelState.rows.length,
    page: panelState.page,
    pages: pageCount(),
    result: panelState.result ?? null,
    error: panelState.error ?? null,
    exportError: panelState.exportError ?? null,
    exporting: panelState.exporting,
  }
}

/* Commit a folder the person explicitly chose (button or preset) and remember it. */
function commitOutDir(raw) {
  const checked = checkOutDir(raw)
  if (checked.dir === null) {
    // The one place a refusal becomes visible: the person pressed something, so
    // telling them why the folder did not take is help, not noise. The previous
    // folder stays, so a typo can never send an export to `/root` or through `..`.
    outDirWarning = checked.reason ?? 'invalid-path'
    bump()
    return { toast: outDirReasonText(outDirWarning, false).slice(0, 40), patch: panelData(), refresh: true }
  }
  outDir = checked.dir
  outDirDraft = checked.dir
  outDirWarning = null
  void savePrefs()
  bump()
  return { toast: `导出位置：${outDir}`.slice(0, 40), patch: panelData(), refresh: true }
}

/**
 * One action per preset (`preset0`, `preset1`, …), generated from the table so
 * the panel view and the handlers cannot drift apart. `actions` items carry an
 * action id, not a value, so the index is what travels back.
 */
function presetActions() {
  const out = {}
  for (let index = 0; index < OUT_DIR_PRESETS.length; index += 1) {
    out[`preset${index}`] = () => commitOutDir(OUT_DIR_PRESETS[index].value)
  }
  return out
}

function registerPanel(panelCtx) {
  panelCtx.dshGo.panel('deepseek-export', {
    view: panelView,
    data: (_scope, emit) => {
      panelEmit = emit
      emit(panelData())
      // The first open (and any open after a restart) fills the list on demand.
      if (Date.now() - panelState.loadedAt > 10_000) {
        void refreshRows().then(() => emit(panelData()), () => emit(panelData()))
      }
      return () => {
        panelEmit = null
      }
    },
    actions: {
      /**
       * The text box's `onChange`. It records what is being typed and nothing
       * else: `outDir` stays on the last folder the person confirmed, so a
       * half-typed path (which may already be legal, e.g. `/sdcard/D`) can never
       * become the folder an export writes to or that `savePrefs` remembers.
       * It also never raises the warning box: the yellow "位置为空，已用默认位置"
       * was this handler reacting to the App's own empty-value echo at first
       * render, which is what the person saw before they had typed anything.
       */
      outDirTyping: (_scope, event) => {
        const text = controlText(event)
        // No value in the echo: nothing to record, and certainly nothing to warn
        // about. Answering with the current data keeps the box in step.
        if (text === null) return { patch: panelData() }
        outDirDraft = text
        return { patch: panelData() }
      },
      /**
       * "Use this folder" — the only place a refusal becomes visible. The value
       * comes from the field when the App sends it, and from the recorded draft
       * when it only sends the tap (a button carries no field value).
       */
      outDirSet: (_scope, event) => commitOutDir(controlText(event) ?? outDirDraft ?? outDir),
      ...presetActions(),
      /**
       * Two payload shapes are possible and the App never says which one it is
       * using, so the shape itself decides:
       *   - an array is the control's whole selection → replace (empty clears);
       *   - a bare string is the one session just tapped → flip that one.
       * Size is deliberately not the signal: an array holding exactly one id is
       * a full set too, and flipping it would deselect the user's last choice.
       */
      toggle: (_scope, event) => {
        const raw = event?.value?.value ?? event?.value?.values ?? event?.value
        const ids = (Array.isArray(raw) ? raw : []).filter((id) => typeof id === 'string')
        if (Array.isArray(raw)) {
          panelState.selected.clear()
          for (const id of ids) panelState.selected.add(id)
        } else if (typeof raw === 'string' && raw !== '') {
          if (panelState.selected.has(raw)) panelState.selected.delete(raw)
          else panelState.selected.add(raw)
        } else {
          return { toast: '没有读到选择' }
        }
        bump()
        return { patch: panelData(), refresh: true }
      },
      selectPage: () => {
        for (const row of pageRows()) panelState.selected.add(row.id)
        bump()
        return { patch: panelData(), refresh: true }
      },
      selectReal: () => {
        panelState.selected.clear()
        for (const row of panelState.rows) {
          if (row.origin !== 'subagent') panelState.selected.add(row.id)
        }
        bump()
        return { patch: panelData(), refresh: true }
      },
      clearAll: () => {
        panelState.selected.clear()
        bump()
        return { patch: panelData(), refresh: true }
      },
      pagePrev: () => {
        panelState.page = Math.max(0, panelState.page - 1)
        bump()
        return { patch: panelData(), refresh: true }
      },
      pageNext: () => {
        panelState.page = Math.min(pageCount() - 1, panelState.page + 1)
        bump()
        return { patch: panelData(), refresh: true }
      },
      refresh: async () => {
        await refreshRows({ force: true })
        bump()
        return { toast: `已读取 ${panelState.rows.length} 个会话`.slice(0, 40), patch: panelData(), refresh: true }
      },
      export: async () => {
        const ids = [...panelState.selected]
        if (ids.length === 0) return { toast: '先勾选要导出的会话' }
        if (panelState.exporting) return { toast: '正在导出，请稍候' }
        panelState.exporting = true
        panelState.result = null
        panelState.exportError = null
        bump()
        try {
          const result = await exportToDisk(ids, outDir)
          panelState.result = {
            sessions: result.sessions,
            messages: result.messages,
            images: result.images,
            imagesMissing: result.imagesMissing,
            bytes: result.bytes,
            outFile: result.outFile,
            outDir: result.outDir,
            dirWarning: result.dirWarning ?? null,
            missingSessions: result.missingSessions ?? [],
          }
          panelState.exporting = false
          // A successful run must not leave the previous failure on screen.
          panelState.exportError = null
          bump()
          const folderNote = result.dirWarning ? '（位置已回退）' : ''
          return {
            toast: `已导出 ${result.sessions} 个会话，${formatBytes(result.bytes)}${folderNote}`.slice(0, 40),
            patch: panelData(),
            refresh: true,
          }
        } catch (error) {
          panelState.exporting = false
          panelState.exportError = String(error?.code ?? error?.message ?? 'error')
          bump()
          return {
            toast: `导出失败：${panelState.exportError}`.slice(0, 40),
            patch: panelData(),
            refresh: true,
          }
        }
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  logger = ctx.logger ?? null
  hostCtx = ctx

  // The remembered export folder comes back before any view or export runs.
  void loadPrefs().then(() => bump(), () => bump())

  ctx.inject(['sessionPersistence'], (svc) => {
    persistence = svc.sessionPersistence
    notifyPersistence?.()
    // A freshly bound service means the cached titles belong to another process.
    summaryCache.clear()
    panelState.loadedAt = 0
    bump()
  })

  ctx.inject(['dshGo'], (panelCtx) => {
    try {
      registerPanel(panelCtx)
    } catch (error) {
      warn(`the native panel is unavailable (${error?.code ?? 'error'})`)
    }
  })

  ctx.inject(['webServer'], (hostCtx) => {
    for (const route of [sessionsRoute(ctx), exportRoute(ctx), prefsRoute(ctx)]) {
      hostCtx.effect(() => hostCtx.webServer.register(route))
    }
  })
}
