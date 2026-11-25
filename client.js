/**
 * dsh-deepseek-exporter — web client half.
 *
 * One sidebar panel ("导出会话 → DeepSeek 格式") that lists stored sessions, takes a
 * multi-selection across pages, and exports the picked ones as one DeepSeek
 * official-format v3 ZIP.
 *
 * Delivery, two answers from the same Host route:
 *   - browser download: POST /deepseek-export/api/export?download=1 → application/zip
 *   - phone storage:    POST /deepseek-export/api/export            → JSON with the
 *     written path (Download/DSH-Go), which the native panel also uses.
 *
 * Every element is plain DOM with the shell's own theme variables, so the panel
 * follows the light/dark theme without importing any UI primitive.
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-exporter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/deepseek-export/api'
    const PANEL_ID = 'deepseek-export'
    const PAGE_SIZE = 8
    const MAX_SELECTED = 64

    // ---------------------------------------------------------------- helpers

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
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

    function archiveName() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `deepseek-export-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`
    }

    function rowTitle(row) {
      return row.title ? row.title : `未命名 ${String(row.id).slice(-8)}`
    }

    function rowMeta(row) {
      const parts = []
      // Subagent sessions are noise for a DeepSeek export; say so on the row.
      if (row.origin === 'subagent') parts.push('子代理')
      parts.push(row.messages === null || row.messages === undefined ? '消息数 —' : `${row.messages} 条消息`)
      parts.push(formatDate(row.updatedAt))
      if (row.projectDir) parts.push(row.projectDir)
      return parts.join(' · ')
    }

    /** Hand a ZIP blob to the browser download manager, then release the URL. */
    function saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }

    // ----------------------------------------------------------------- styles

    const CSS = `
.dse{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;overflow:hidden}
.dse *{box-sizing:border-box}
.dse-head{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dse-title{font-weight:600;font-size:14px}
.dse-count{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dse-sp{flex:1}
.dse-body{flex:1;min-height:0;overflow:auto;padding:10px 20px 20px}
.dse-btn{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.dse-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dse-btn:disabled{opacity:.45;cursor:default}
.dse-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dse-row{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:9px;border:1px solid transparent;cursor:pointer}
.dse-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dse-row.on{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l2)}
.dse-row input{margin:3px 0 0;flex:none;accent-color:var(--dsw-alias-brand-primary)}
.dse-row-main{min-width:0;flex:1}
.dse-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dse-row-meta{color:var(--dsw-alias-label-tertiary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dse-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0 0}
.dse-empty{color:var(--dsw-alias-label-tertiary);padding:18px 2px}
.dse-note{padding:9px 11px;border-radius:9px;font-size:12.5px;margin:0 0 10px;border:1px solid var(--dsw-alias-border-l2)}
.dse-note.bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dse-note.good{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dse-note.warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.dse-path{font-family:var(--dsw-font-mono,monospace);font-size:11.5px;word-break:break-all;opacity:.85}
.dse-sep{height:1px;background:var(--dsw-alias-border-l1);margin:12px 0}
.dse-dest{display:flex;flex-direction:column;gap:8px;margin:14px 0 0;padding:11px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2)}
.dse-dest-head{display:flex;align-items:center;gap:8px}
.dse-dest-title{font-weight:600}
.dse-dest input[type=text]{width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-family:var(--dsw-font-mono,monospace);font-size:12px}
.dse-dest input[type=text]:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dse-presets{display:flex;gap:6px;flex-wrap:wrap}
.dse-chip{height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dse-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dse-chip.on{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dse-chip:disabled{opacity:.45;cursor:default}
.dse-hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
`

    // ------------------------------------------------------------------- icon

    function PanelIcon(props) {
      const size = props?.size || 18
      const active = props?.active === true
      return h('span', {
        style: { display: 'inline-flex', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      }, h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, [
        h('path', { key: 'tray', d: 'M12 3v11' }),
        h('path', { key: 'arrow', d: 'M8 10l4 4 4-4' }),
        h('path', { key: 'box', d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }),
      ]))
    }

    // ------------------------------------------------------------------ panel

    function ExportPanel() {
      const [rows, setRows] = React.useState([])
      const [loaded, setLoaded] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [selected, setSelected] = React.useState([])
      const [page, setPage] = React.useState(0)
      const [loading, setLoading] = React.useState(false)
      const [exporting, setExporting] = React.useState(null)
      const [result, setResult] = React.useState(null)
      // Where "保存到手机" writes. Read from the Host so the web panel and the
      // phone's native panel always agree on one remembered folder.
      const [outDir, setOutDir] = React.useState('')
      const [outDirDefault, setOutDirDefault] = React.useState('')
      const [presets, setPresets] = React.useState([])
      const [outDirMax, setOutDirMax] = React.useState(200)
      const [outDirNote, setOutDirNote] = React.useState(null)
      const [savingDir, setSavingDir] = React.useState(false)

      const load = React.useCallback(async (force) => {
        setLoading(true)
        setError(null)
        try {
          const response = await fetch(`${API}/sessions${force ? '?refresh=1' : ''}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`列出会话失败：HTTP ${response.status}`)
          const body = await response.json()
          const list = Array.isArray(body.sessions) ? body.sessions : []
          setRows(list)
          setSelected((previous) => previous.filter((id) => list.some((row) => row.id === id)))
          return list
        } catch (failure) {
          setError(messageOf(failure))
          return []
        } finally {
          setLoading(false)
          setLoaded(true)
        }
      }, [])

      React.useEffect(() => {
        load(false)
      }, [load])

      /**
       * The remembered folder, its presets and the default. A Host half from
       * before `/api/prefs` existed answers 404 here; the folder box then simply
       * does not appear and the two export buttons behave as they always did.
       */
      React.useEffect(() => {
        let live = true
        ;(async () => {
          try {
            const response = await fetch(`${API}/prefs`, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return
            const body = await response.json()
            if (!live) return
            if (typeof body.outDir === 'string') setOutDir(body.outDir)
            if (typeof body.defaultOutDir === 'string') setOutDirDefault(body.defaultOutDir)
            if (Array.isArray(body.presets)) setPresets(body.presets.filter((p) => p && typeof p.value === 'string'))
            if (Number.isInteger(body.maxLength)) setOutDirMax(body.maxLength)
          } catch { /* an older Host half: no folder control */ }
        })()
        return () => { live = false }
      }, [])

      /**
       * Remember a folder on the Host. The Host owns the rule (only /sdcard
       * below the root, no `..`), so the browser never validates on its own and
       * never invents a message: whatever it answers is what is shown.
       */
      async function saveOutDir(value) {
        setSavingDir(true)
        setOutDirNote(null)
        try {
          const response = await fetch(`${API}/prefs`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ outDir: value }),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) {
            setOutDirNote({ tone: 'bad', text: typeof body.message === 'string' ? body.message : `位置不可用（${response.status}）` })
            return false
          }
          if (typeof body.outDir === 'string') {
            setOutDir(body.outDir)
            setResult(null)
            setOutDirNote({ tone: 'good', text: `保存位置已改为 ${body.outDir}` })
          }
          return true
        } catch (failure) {
          setOutDirNote({ tone: 'bad', text: messageOf(failure) })
          return false
        } finally {
          setSavingDir(false)
        }
      }

      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
      const current = Math.min(page, pages - 1)
      const visible = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
      const pageIds = visible.map((row) => row.id)
      const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.includes(id))

      const toggle = (id) => {
        setResult(null)
        setSelected((previous) => {
          if (previous.includes(id)) return previous.filter((value) => value !== id)
          if (previous.length >= MAX_SELECTED) return previous
          return [...previous, id]
        })
      }

      const togglePage = () => {
        setResult(null)
        setSelected((previous) => {
          if (allOnPage) return previous.filter((id) => !pageIds.includes(id))
          const next = [...previous]
          for (const id of pageIds) if (!next.includes(id) && next.length < MAX_SELECTED) next.push(id)
          return next
        })
      }

      /**
       * Select every real conversation and drop the subagent ones.
       *
       * The Host has to say which is which. `/api/sessions` carries `origin` for
       * each row (null for a conversation a person started, 'subagent' for one a
       * delegated agent started). If the field is missing entirely — an older
       * Host half — this asks for a fresh listing once, and if it is still absent
       * it says so instead of silently selecting everything.
       */
      async function selectRealChats() {
        setResult(null)
        let list = rows
        if (list.length > 0 && !list.some((row) => row.origin !== undefined)) {
          // This Host half does not report `origin`; one forced listing may.
          const fresh = await load(true)
          if (fresh.length > 0) list = fresh
          if (!list.some((row) => row.origin !== undefined)) {
            setError('这个 Host 没有返回 origin，无法区分真实对话与子代理会话，已改为全选。')
          }
        }
        // With no origin at all nothing matches 'subagent', so this is a plain
        // select-all — which is what the message above tells the person happened.
        const next = []
        for (const row of list) {
          if (row.origin === 'subagent') continue
          if (next.length >= MAX_SELECTED) break
          next.push(row.id)
        }
        setSelected(next)
      }

      const realCount = rows.filter((row) => row.origin !== 'subagent').length
      const subagentCount = rows.length - realCount
      const hasOrigin = rows.some((row) => row.origin !== undefined)

      async function exportWith({ download }) {
        if (selected.length === 0) return
        setExporting(download ? 'download' : 'disk')
        setError(null)
        setResult(null)
        try {
          // The folder rides along on the disk answer only: a browser download
          // never touches the phone's storage, so it needs no folder at all.
          const payload = download
            ? { sessionIds: selected }
            : { sessionIds: selected, ...(outDir.trim() !== '' ? { outDir: outDir.trim() } : {}) }
          const response = await fetch(`${API}/export${download ? '?download=1' : ''}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: download
              ? { 'content-type': 'application/json', accept: 'application/zip' }
              : { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!response.ok) {
            let detail = `HTTP ${response.status}`
            try {
              const body = await response.json()
              // The Host sends a human sentence for a refused folder; prefer it
              // to the bare code, which means nothing to the person reading it.
              if (body && typeof body.message === 'string') detail = body.message
              else if (body && typeof body.code === 'string') detail = body.code
            } catch { /* a non-JSON error body keeps the status */ }
            throw new Error(detail)
          }
          if (download) {
            const blob = await response.blob()
            const name = archiveName()
            saveBlob(blob, name)
            setResult({ kind: 'download', bytes: blob.size, name, sessions: selected.length })
          } else {
            const body = await response.json()
            setResult({
              kind: 'disk',
              bytes: body.bytes,
              path: body.path,
              sessions: body.sessions,
              dirWarning: typeof body.dirWarning === 'string' ? body.dirWarning : null,
              missing: Array.isArray(body.missingSessions) ? body.missingSessions.length : 0,
            })
          }
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setExporting(null)
        }
      }

      const busy = exporting !== null

      return h('div', { className: 'dse' }, [
        h('style', { key: 'css', dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'dse-head', key: 'head' }, [
          h('span', { className: 'dse-title', key: 'title' }, '导出会话 → DeepSeek 格式'),
          h('span', { className: 'dse-count', key: 'count' },
            `${rows.length} 个会话${subagentCount > 0 ? `（${subagentCount} 个子代理）` : ''} · 已选 ${selected.length}`),
          h('span', { className: 'dse-sp', key: 'sp' }),
          h('button', {
            key: 'refresh', type: 'button', className: 'dse-btn',
            disabled: loading || busy,
            onClick: () => { load(true) },
          }, loading ? '正在读取…' : '刷新列表'),
        ]),
        h('div', { className: 'dse-body', key: 'body' }, [
          error ? h('div', { key: 'err', className: 'dse-note bad' }, error) : null,
          result && result.kind === 'download'
            ? h('div', { key: 'ok', className: 'dse-note good' },
                `已导出 ${result.sessions} 个会话（${formatBytes(result.bytes)}），浏览器正在下载 ${result.name}`)
            : null,
          result && result.kind === 'disk'
            ? h('div', { key: 'okdisk', className: 'dse-note good' }, [
                h('div', { key: 'line' }, `已写入本机：${result.sessions} 个会话 · ${formatBytes(result.bytes)}`),
                h('div', { key: 'path', className: 'dse-path' }, String(result.path ?? '')),
                result.dirWarning
                  ? h('div', { key: 'warn' }, '填的导出位置不能用，已回退到默认位置（Download/DSH-Go）')
                  : null,
                result.missing > 0
                  ? h('div', { key: 'miss' }, `${result.missing} 个所选会话已不存在，已跳过`)
                  : null,
              ])
            : null,
          !loaded && loading
            ? h('div', { key: 'loading', className: 'dse-empty' }, '正在读取会话…')
            : null,
          loaded && rows.length === 0 && !error
            ? h('div', { key: 'none', className: 'dse-empty' }, '没有找到会话。')
            : null,
          ...visible.map((row) => h('label', {
            key: row.id,
            className: `dse-row${selected.includes(row.id) ? ' on' : ''}`,
          }, [
            h('input', {
              key: 'box', type: 'checkbox',
              checked: selected.includes(row.id),
              onChange: () => { toggle(row.id) },
            }),
            h('span', { key: 'main', className: 'dse-row-main' }, [
              h('div', { key: 't', className: 'dse-row-title' }, rowTitle(row)),
              h('div', { key: 'm', className: 'dse-row-meta' }, rowMeta(row)),
            ]),
          ])),
          rows.length > 0
            ? h('div', { key: 'sep', className: 'dse-sep' })
            : null,
          presets.length > 0 || outDir !== ''
            ? h('div', { key: 'dest', className: 'dse-dest' }, [
                h('div', { key: 'h', className: 'dse-dest-head' }, [
                  h('span', { key: 't', className: 'dse-dest-title' }, '保存位置'),
                  h('span', { key: 'sp', className: 'dse-sp' }),
                  h('span', { key: 'hint', className: 'dse-hint' },
                    outDirDefault ? `默认 ${outDirDefault}` : ''),
                ]),
                h('input', {
                  key: 'in', type: 'text',
                  value: outDir,
                  maxLength: outDirMax,
                  spellCheck: false,
                  placeholder: outDirDefault,
                  disabled: busy || savingDir,
                  onChange: (event) => { setOutDir(event.target.value); setOutDirNote(null) },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !busy && !savingDir) saveOutDir(outDir)
                  },
                }),
                presets.length > 0
                  ? h('div', { key: 'presets', className: 'dse-presets' },
                      presets.map((preset) => h('button', {
                        key: preset.value,
                        type: 'button',
                        className: `dse-chip${outDir === preset.value ? ' on' : ''}`,
                        disabled: busy || savingDir,
                        title: preset.value,
                        onClick: () => { saveOutDir(preset.value) },
                      }, preset.label)))
                  : null,
                h('div', { key: 'row', className: 'dse-foot' }, [
                  h('button', {
                    key: 'save', type: 'button', className: 'dse-btn',
                    disabled: busy || savingDir || outDir.trim() === '',
                    onClick: () => { saveOutDir(outDir) },
                  }, savingDir ? '正在保存…' : '使用这个位置'),
                  h('span', { key: 'hint2', className: 'dse-hint' },
                    '只能写到 /sdcard 下面；「保存到手机」写进这里'),
                ]),
                outDirNote
                  ? h('div', {
                      key: 'note',
                      className: `dse-note ${outDirNote.tone === 'bad' ? 'bad' : 'good'}`,
                      style: { margin: 0 },
                    }, outDirNote.text)
                  : null,
              ])
            : null,
          rows.length > 0
            ? h('div', { key: 'foot', className: 'dse-foot' }, [
                h('button', {
                  key: 'page', type: 'button', className: 'dse-btn', disabled: busy,
                  onClick: togglePage,
                }, allOnPage ? '取消本页' : '选中本页'),
                h('button', {
                  key: 'real', type: 'button', className: 'dse-btn', disabled: busy || rows.length === 0,
                  title: subagentCount > 0
                    ? `只选由人发起的对话，跳过 ${subagentCount} 个子代理会话`
                    : '只选由人发起的对话，跳过子代理会话',
                  onClick: () => { selectRealChats() },
                }, hasOrigin ? `只选真实对话（${realCount}）` : '只选真实对话'),
                h('button', {
                  key: 'clear', type: 'button', className: 'dse-btn', disabled: busy || selected.length === 0,
                  onClick: () => { setSelected([]); setResult(null) },
                }, '清空选择'),
                pages > 1 ? h('button', {
                  key: 'prev', type: 'button', className: 'dse-btn', disabled: busy || current === 0,
                  onClick: () => { setPage(Math.max(0, current - 1)) },
                }, '上一页') : null,
                pages > 1 ? h('span', { key: 'pageno', className: 'dse-count' }, `第 ${current + 1} / ${pages} 页`) : null,
                pages > 1 ? h('button', {
                  key: 'next', type: 'button', className: 'dse-btn', disabled: busy || current >= pages - 1,
                  onClick: () => { setPage(Math.min(pages - 1, current + 1)) },
                }, '下一页') : null,
                h('span', { key: 'sp2', className: 'dse-sp' }),
                h('button', {
                  key: 'disk', type: 'button', className: 'dse-btn',
                  disabled: busy || selected.length === 0,
                  title: `写到手机 ${outDir || outDirDefault || 'Download/DSH-Go'}，和原生面板同一个位置`,
                  onClick: () => { exportWith({ download: false }) },
                }, exporting === 'disk' ? '正在写入…' : '保存到手机'),
                h('button', {
                  key: 'dl', type: 'button', className: 'dse-btn primary',
                  disabled: busy || selected.length === 0,
                  onClick: () => { exportWith({ download: true }) },
                }, exporting === 'download' ? '正在打包…' : '导出并下载'),
              ])
            : null,
        ]),
      ])
    }

    // --------------------------------------------------------------- register

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: '导出会话 → DeepSeek 格式',
        }, PanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, ExportPanel))
      },
    }
  },
})
