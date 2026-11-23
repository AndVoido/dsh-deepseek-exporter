/**
 * DSH session -> DeepSeek official export format v3 (ZIP).
 *
 * Writes only the fields the official importer validates
 * (dsh-deepseek-chat-import lib/index.js:23-145). Nothing else is emitted.
 *
 * Only Node built-ins are used; the ZIP writer is hand-rolled (method 0 = store).
 * Session logs are read through the host's `sessionPersistence` service when one
 * is supplied, so this module never hand-decodes the on-disk log format.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Absolute DSH home directory. Resolved on every call: never baked in. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), '.dsh')
}

export function sessionRoot() {
  return join(dshHome(), 'sessions')
}

export function attachmentRoot() {
  return join(dshHome(), 'attachments', 'v1')
}

/** Image media types the official importer accepts in `_files/` entries. */
const IMAGE_EXT = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])

/** DSH `source.kind` values that count as a human turn in the transcript. */
const DEFAULT_USER_SOURCE_KINDS = ['user']

// ---------------------------------------------------------------------------
// ZIP (store-only)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Build a stored (uncompressed) ZIP archive.
 * @param entries - ordered `{ name, data }`; `data` is a Buffer or string.
 * @param options.mtime - modification timestamp recorded on every entry.
 * @returns the archive bytes.
 */
export function buildZip(entries, options = {}) {
  if (entries.length > 0xffff) throw new Error('too many entries for a non-ZIP64 archive')
  const when = dosDateTime(options.mtime ?? new Date())
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // method 0 = store
    local.writeUInt16LE(when.dosTime, 10)
    local.writeUInt16LE(when.dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBytes, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(when.dosTime, 12)
    cd.writeUInt16LE(when.dosDate, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBytes.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBytes]))

    offset += local.length + nameBytes.length + data.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, directory, end])
}

// ---------------------------------------------------------------------------
// Session access
// ---------------------------------------------------------------------------

let fallbackContext

/**
 * Import one of the engine's own packages. Inside the plugin the host supplies
 * the service, so this only runs for a standalone caller (a script or a test),
 * where `@deepseek-ai/*` lives in the engine's tree, not in the plugin's.
 */
async function importOfficial(specifier) {
  try {
    return await import(specifier)
  } catch (firstError) {
    const bases = []
    if (typeof process.env.DSH_RUNTIME_MODULES === 'string' && process.env.DSH_RUNTIME_MODULES !== '') {
      bases.push(join(process.env.DSH_RUNTIME_MODULES, 'noop.js'))
    }
    if (typeof process.argv[1] === 'string' && process.argv[1] !== '') bases.push(process.argv[1])
    // The engine checkout that started this process, if it is the standard one.
    bases.push('/opt/dsh/noop.js')
    for (const base of bases) {
      try {
        const req = createRequire(base)
        return await import(pathToFileURL(req.resolve(specifier)).href)
      } catch { /* try the next base */ }
    }
    throw firstError
  }
}

/**
 * Resolve a `sessionPersistence` service. The plugin passes the host's service
 * (imported officially, same instance the engine uses); a standalone caller
 * (a script, a test) gets a private read-only context over the same root.
 */
async function openPersistence(explicit) {
  if (explicit && typeof explicit.open === 'function') return explicit
  if (fallbackContext) return fallbackContext
  const { Context } = await importOfficial('@deepseek-ai/cordis')
  const persistence = await importOfficial('@deepseek-ai/dsh-session-persistence-jsonl')
  const ctx = new Context()
  ctx.plugin(persistence, { root: sessionRoot(), compression: 'zstd' })
  for (let attempt = 0; attempt < 60; attempt++) {
    const service = ctx.get('sessionPersistence')
    if (service) {
      fallbackContext = service
      return fallbackContext
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('sessionPersistence service did not become available')
}

/** List every stored session header, newest first. */
export async function listSessions(service) {
  const persistence = await openPersistence(service)
  const snapshots = await persistence.list()
  const rows = snapshots.map((snapshot) => ({
    id: snapshot.header.id,
    createdAt: snapshot.header.createdAt ?? null,
    cwd: typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : null,
    parentSession: snapshot.header.parentSession ?? null,
    origin: snapshot.header.origin ?? null,
    sizeBytes: snapshot.sizeBytes ?? null,
  }))
  rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return rows
}

async function readSessionEvents(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const slice = await handle.read()
    return slice.events
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function digestOf(attachmentId) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(String(attachmentId))
  return match?.[1]
}

/** Deterministic UUID-shaped file id so the importer strips it back off the name. */
function fileIdFromDigest(digest) {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}

async function readImageBytes(attachmentId) {
  const digest = digestOf(attachmentId)
  if (!digest) return undefined
  try {
    return await readFile(join(attachmentRoot(), 'objects', digest.slice(0, 2), digest))
  } catch {
    return undefined
  }
}

function leafName(name, fallback) {
  if (typeof name !== 'string') return fallback
  const leaf = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim()
  return clean === '' ? fallback : clean
}

// ---------------------------------------------------------------------------
// Conversation conversion
// ---------------------------------------------------------------------------

function isoTime(time, fallback) {
  const value = Number.isFinite(time) ? time : fallback
  return new Date(value).toISOString()
}

function pickTitle(events, firstUserText) {
  let title
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  if (typeof firstUserText === 'string' && firstUserText.trim() !== '') {
    return firstUserText.trim().slice(0, 24)
  }
  return null
}

/** Flatten one message's content blocks into ordered fragment descriptors. */
function describeBlocks(blocks) {
  const items = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const last = items[items.length - 1]
      if (last?.kind === 'text') last.text += `\n${block.text}`
      else items.push({ kind: 'text', text: block.text })
    } else if (block?.type === 'reasoning' && typeof block.text === 'string') {
      const last = items[items.length - 1]
      if (last?.kind === 'think') last.text += `\n${block.text}`
      else items.push({ kind: 'think', text: block.text })
    } else if (block?.type === 'image' || block?.type === 'file') {
      items.push({ kind: block.type, attachment: block.attachment })
    }
  }
  return items
}

/** A short human label for one session, from its own title event or first prompt. */
export function titleFromEvents(events) {
  let title
  let firstUserText
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
    if (firstUserText === undefined && event?.type === 'user/message') {
      const parts = Array.isArray(event.data?.content) ? event.data.content : []
      const text = parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text !== '') firstUserText = text
    }
  }
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  if (typeof firstUserText === 'string') return firstUserText.length > 48 ? `${firstUserText.slice(0, 48)}…` : firstUserText
  return null
}

/**
 * Convert one DSH session's events into a DeepSeek export conversation file.
 * @returns `{ file, entries, images, imagesMissing }`.
 */
async function convertSession(sessionId, events, options) {
  const userKinds = new Set(options.userSourceKinds)
  const filesDir = `chat_sessions/${sessionId}_files`
  const entries = []
  const messages = []
  let images = 0
  let imagesMissing = 0
  let imageSeq = 0
  let lastTime = 0

  const imagesByDigest = new Map()

  /** Emit a FILE fragment for an image/file attachment, staging bytes when possible. */
  const fileFragment = async (attachment, isImage) => {
    if (isImage) {
      const digest = digestOf(attachment?.attachmentId)
      const mediaType = attachment?.mediaType
      const extension = IMAGE_EXT.get(mediaType)
      const index = ++imageSeq
      const name = leafName(attachment?.name, `image_${index}${extension ?? ''}`)
      const fileId = digest ? fileIdFromDigest(digest) : fileIdFromDigest(createHash('sha256').update(`${sessionId}:${index}`).digest('hex'))
      let bytes
      let exportPath = null
      if (extension && digest) {
        if (!imagesByDigest.has(digest)) imagesByDigest.set(digest, await readImageBytes(attachment.attachmentId))
        bytes = imagesByDigest.get(digest)
        if (bytes) {
          exportPath = `${filesDir}/${fileId}_${name}`
          entries.push({ name: exportPath, data: bytes })
        }
      }
      if (exportPath === null) imagesMissing++
      else images++
      return {
        type: 'FILE',
        files: [{ id: fileId, file_name: name, file_size: bytes?.length ?? attachment?.bytes ?? 0, is_image: true, export_path: exportPath }],
      }
    }
    const digest = digestOf(attachment?.attachmentId)
    const name = leafName(attachment?.name, 'file')
    const fileId = digest ? fileIdFromDigest(digest) : fileIdFromDigest(createHash('sha256').update(`${sessionId}:f:${name}`).digest('hex'))
    // Non-image files are described, never embedded: the official importer only
    // restores `_files/` entries it recognises as images.
    return {
      type: 'FILE',
      files: [{ id: fileId, file_name: name, file_size: attachment?.bytes ?? 0, is_image: false, export_path: null }],
    }
  }

  /** Turn block descriptors into DeepSeek fragments for one role. */
  const fragmentsFor = async (items, role) => {
    const fragments = []
    const files = []
    for (const item of items) {
      if (item.kind === 'think') {
        const content = item.text.trim()
        if (content !== '') fragments.push({ type: 'THINK', content: item.text, elapsed_secs: null })
      } else if (item.kind === 'text') {
        fragments.push({ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content: item.text })
      } else if (item.kind === 'image') {
        files.push(await fileFragment(item.attachment, true))
      } else if (item.kind === 'file') {
        files.push(await fileFragment(item.attachment, false))
      }
    }
    const usable = fragments.filter((fragment) => fragment.type === 'THINK' || String(fragment.content ?? '').trim() !== '')
    const fileFragments = files.filter((fragment) => fragment.files.length > 0)
    return [...fileFragments, ...usable]
  }

  const pushMessage = (role, fragments, time) => {
    if (fragments.length === 0) return
    const id = messages.length + 1
    lastTime = Math.max(lastTime, Number.isFinite(time) ? time : lastTime)
    messages.push({
      id,
      parent_id: id === 1 ? null : id - 1,
      role,
      status: 'FINISHED',
      inserted_at: isoTime(lastTime, 0),
      fragments,
    })
  }

  let firstUserText
  /** Mutable accumulator for the assistant reply of the current turn. */
  let reply = null

  const flushReply = async () => {
    if (!reply) return
    const pending = reply
    reply = null
    const fragments = await fragmentsFor(pending.items, 'ASSISTANT')
    pushMessage('ASSISTANT', fragments, pending.time)
  }

  for (const event of events) {
    if (event?.surfaceOp !== 'append') continue
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind ?? 'user'
      if (!userKinds.has(kind)) continue
      const items = describeBlocks(event.data?.content)
      const text = items.filter((item) => item.kind === 'text').map((item) => item.text).join('\n')
      if (firstUserText === undefined && text.trim() !== '') firstUserText = text.trim()
      await flushReply()
      const fragments = await fragmentsFor(items, 'USER')
      pushMessage('USER', fragments, event.time)
    } else if (event.type === 'assistant/message') {
      const turn = event.data?.turn
      if (reply && reply.turn !== turn) await flushReply()
      if (!reply) reply = { turn, items: [], time: event.time }
      reply.items.push(...describeBlocks(event.data?.message?.content))
      reply.time = event.time
    }
  }
  await flushReply()

  const title = pickTitle(events, firstUserText)
  const first = messages[0]
  const file = {
    id: sessionId,
    title,
    current_message_id: messages.length > 0 ? messages[messages.length - 1].id : null,
    inserted_at: first ? first.inserted_at : isoTime(events[0]?.time, 0),
    messages,
  }
  return { file, entries, images, imagesMissing }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Export DSH sessions as one DeepSeek official-format v3 ZIP.
 * @param options.outFile - absolute path of the ZIP to write; required unless `buffer` is set.
 * @param options.sessionIds - session ids to export; omitted exports the newest `maxSessions`.
 * @param options.maxSessions - cap when `sessionIds` is omitted (default 2 for safe testing).
 * @param options.userSourceKinds - DSH `source.kind` values treated as human turns.
 * @param options.service - an already-loaded `sessionPersistence` service (the plugin passes one).
 * @param options.buffer - when true, write nothing and return the archive bytes in `archive`.
 * @returns `{ sessions, messages, images, imagesMissing, bytes, outFile, ids, missingSessions }`,
 *   plus `archive` (a Buffer) in buffer mode and `outFile: null`.
 */
export async function exportSessions({
  outFile,
  sessionIds,
  maxSessions = 2,
  userSourceKinds = DEFAULT_USER_SOURCE_KINDS,
  service,
  buffer = false,
} = {}) {
  if (!buffer && (typeof outFile !== 'string' || outFile === '')) throw new Error('outFile is required')
  const persistence = await openPersistence(service)
  const available = (await listSessions(persistence)).map((row) => row.id)
  const known = new Set(available)
  let ids
  let missingSessions = []
  if (Array.isArray(sessionIds) && sessionIds.length > 0) {
    missingSessions = sessionIds.filter((id) => !known.has(id))
    ids = sessionIds.filter((id) => known.has(id))
  } else {
    ids = available.slice(0, Math.max(1, maxSessions))
  }
  if (ids.length === 0) throw new Error(`no DSH session to export (missing: ${missingSessions.join(', ') || 'none'})`)

  const stamp = new Date()
  const index = []
  const conversationEntries = []
  let messages = 0
  let images = 0
  let imagesMissing = 0

  for (const sessionId of ids) {
    const events = await readSessionEvents(persistence, sessionId)
    const conversion = await convertSession(sessionId, events, { userSourceKinds })
    const { file } = conversion
    messages += file.messages.length
    images += conversion.images
    imagesMissing += conversion.imagesMissing
    conversationEntries.push({
      name: `chat_sessions/${sessionId}.json`,
      data: JSON.stringify(file),
    })
    conversationEntries.push(...conversion.entries)
    const updated = file.messages.length > 0 ? file.messages[file.messages.length - 1].inserted_at : file.inserted_at
    index.push({ id: sessionId, inserted_at: file.inserted_at, updated_at: updated })
  }

  const archive = buildZip(
    [
      { name: 'manifest.json', data: JSON.stringify({ export_format_version: 3 }) },
      { name: 'chat_session_index.json', data: JSON.stringify(index) },
      ...conversationEntries,
    ],
    { mtime: stamp },
  )
  if (!buffer) await writeFile(outFile, archive)
  return {
    sessions: ids.length,
    messages,
    images,
    imagesMissing,
    bytes: archive.length,
    outFile: buffer ? null : outFile,
    ids,
    missingSessions,
    ...buffer ? { archive } : {},
  }
}

export default exportSessions
