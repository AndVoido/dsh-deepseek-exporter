# 会话导出（dsh-deepseek-exporter）
Export DSH sessions to DeepSeek's official v3 ZIP format.

## Why

DSH stores its conversations in its own event log format. DeepSeek's web and
mobile apps import a completely different archive layout (`manifest.json`,
`chat_session_index.json`, one JSON file per conversation). There is no
converter in between, so a DSH session cannot be carried anywhere else.

This plugin bridges the two. Pick the sessions you want, get a ZIP whose layout
matches what DeepSeek's importer expects.

## Features

- **Native panel in the dsh-go phone app** — check sessions, tap export, the ZIP
  lands on shared storage.
- **Web UI in the DSH web client** — a row under the sidebar's **More** menu; download the ZIP in the
  browser or save it to the phone.
- **"Real chats only"** — one tap to select only sessions a human started,
  skipping subagent sessions.
- **Configurable export folder** — one preset button (Download/DSH-Go)
  plus free-text entry; the folder is created with `mkdir -p` if missing.
- **Path validation** — only `/sdcard/` is writable, `..` is refused, symlink
  escapes are refused.
- **Official DeepSeek v3 layout**, verified against a real DeepSeek export.

## Install

```sh
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-deepseek-exporter
```

This installs a link to the source directory, so **the directory must not be
deleted**. After changing files under `lib/`, restart the engine from the app's
"Engine" page; editing only `package.json` (the manifest) is picked up
automatically.

Changes under `client.js` (the web UI) also need a restart to take effect.

## Usage

### Phone (dsh-go native panel)

1. Open the **Features** page and pick **Session Export** (会话导出).
2. The session list appears with message counts. Use **Select page**,
   **Real chats only**, **Clear**, or check rows individually. Paging controls
   appear when there is more than one page.
3. Optionally change the output folder — preset buttons or type a path under
   `/sdcard`.
4. Tap **Export**. The result line shows session/message/image counts and the
   absolute path of the written ZIP.

The default folder is `/sdcard/Download/DSH-Go`, which is where the app keeps
its other exported artifacts.

### Web (DSH web client)

1. Open the DSH web client; the **会话导出** entry is under the sidebar's **More** menu.
2. Check the sessions you want.
3. Choose a delivery mode:
   - **Export and download** — the browser receives the ZIP directly; nothing
     is written to disk.
   - **Save to phone** — the ZIP is written to the configured folder on the
     host and the resulting path is shown.

`"Real chats only"` filters on `header.origin !== 'subagent'`. If the host does
not expose `origin` at all, the button degrades to selecting everything and says
so, rather than pretending it filtered.

### HTTP routes

Both routes are registered with `auth: 'required'`; when the `connection`
service is unavailable they answer `503` instead of letting the request through.

| Route | Purpose |
| --- | --- |
| `GET /deepseek-export/api/sessions` | List sessions (id, title, message count, timestamps, origin). `?refresh=1` re-reads titles. |
| `POST /deepseek-export/api/export` | `{"sessionIds": [...]}`, 1–64 ids. Without flags: write to disk and return JSON. With `?download=1` or `Accept: application/zip`: stream the ZIP, write nothing. |
| `GET /deepseek-export/api/prefs` | Read the remembered output folder. |

## Output format

```
manifest.json                      {"export_format_version":3}
chat_session_index.json            [{"id","inserted_at","updated_at"}, ...]
chat_sessions/{id}.json            one conversation per file
chat_sessions/{id}_files/{fileId}_{name}   image attachments
```

A conversation file:

```json
{
  "id": "<session id>",
  "title": "Session title",
  "current_message_id": 4,
  "inserted_at": "2026-11-23T06:48:00.000Z",
  "messages": [
    {
      "id": 1,
      "parent_id": null,
      "role": "USER",
      "status": "FINISHED",
      "inserted_at": "2026-11-23T06:48:01.000Z",
      "fragments": [
        { "type": "REQUEST", "content": "..." }
      ]
    }
  ]
}
```

Message and fragment rules, all taken from the source in `lib/export-core.js`:

- `id` is a numeric counter starting at 1; `parent_id` is a single chain
  (`id - 1`, `null` for the first message).
- `role` is `USER` or `ASSISTANT`.
- Fragments: `REQUEST` (user text), `RESPONSE` (assistant text), `THINK`
  (reasoning, with `elapsed_secs`), and `FILE` (attachments:
  `{id, file_name, file_size, is_image, export_path}`).
- Only turns whose `source.kind` is a human kind count as user speech;
  assistant messages of one turn are merged into a single reply.
- Image bytes are read from the attachment store and staged under
  `chat_sessions/{id}_files/`. An image whose bytes cannot be read keeps its
  `FILE` fragment but carries `export_path: null`, and is reported as
  `imagesMissing` in the result.
- Non-image files are described only, never embedded — DeepSeek's importer
  restores only images it recognises.
- The ZIP is stored, not deflated, so its size is roughly the sum of its parts.

The export result reports `sessions`, `messages`, `images`, `imagesMissing`,
`bytes`, and either the written `path` or the delivered archive.

## Path safety

The output folder is validated before anything is written. Refused inputs, each
with its own reason string:

| Input | Result |
| --- | --- |
| empty, non-string, or absurdly long | refused |
| contains a `..` segment | refused |
| contains a NUL byte | refused |
| contains a backslash | refused |
| not absolute | refused |
| outside `/sdcard/` (so `/`, `/root`, `/data` never qualify) | refused |
| exactly `/sdcard` | refused |
| resolves outside `/sdcard` through a symlinked ancestor | refused |

Lexical checks alone are not enough on proot, so the path is also resolved
against the real filesystem: the deepest existing ancestor is `realpath`-ed and
must still sit inside `/sdcard`. Only after that is `mkdir -p` attempted.

When a requested folder is refused, the export does not fail — it falls back to
`/sdcard/Download/DSH-Go`, then to `$DSH_HOME/cache/deepseek-export/` on a host
without shared storage, and reports which fallback was used and why.

Archives older than 24 hours in the target folder are deleted before each
export so the shared folder does not fill up.

## Requirements

- Node.js >= 22.19
- DSH >= 0.2.1-rc.4 < 0.3.0-0
- dsh-go app >= 1.0.4 for the native panel

The plugin uses Node built-in modules only. It reads session logs through the
host's own `sessionPersistence` service instead of decoding them itself.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

把 DSH 会话导出成 **DeepSeek 官方对话导出格式（v3 ZIP）**，方便迁移到
DeepSeek 网页版或其它应用。

### 功能

- **dsh-go 手机原生面板**：勾选会话 → 导出 → 直接写到手机存储
- **Harness 网页端**：侧栏「更多」菜单里的「会话导出」，可下载到浏览器或存到手机
- **「只选真实对话」**：靠 `header.origin !== 'subagent'` 一键跳过子代理会话
- **导出位置可选**：预设按钮（Download/DSH-Go）+ 手动输入，
  目录不存在时自动 `mkdir -p`
- **路径安全**：只允许 `/sdcard/` 下、拒绝 `..`、拒绝符号链接逃逸

### 安装

```sh
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-deepseek-exporter
```

装的是指向源目录的链接，**目录不能删**。改了 `lib/` 下的代码要在 App 的
「引擎」页重启引擎才生效；只改 `package.json` 清单会自动重读。

### 用法

- 手机：打开 App 的「功能」页 → 「会话导出」→ 勾选会话 →
  （可改目录）→ 导出。默认写到 `/sdcard/Download/DSH-Go`。
- 网页端：侧栏「更多」→「会话导出」→ 勾选 → 「导出并下载」或「保存到手机」。
  前者不写盘，后者写盘并返回路径。

### 输出结构

```
manifest.json                      {"export_format_version":3}
chat_session_index.json            [{"id","inserted_at","updated_at"}, ...]
chat_sessions/{id}.json            每个会话一个
chat_sessions/{id}_files/...       图片附件
```

消息结构：numeric `id`、`parent_id` 单链、`role` 为 `USER` / `ASSISTANT`、
`fragments[]`（`REQUEST` / `RESPONSE` / `THINK` / `FILE`）。详见上面英文部分的
「Output format」。

### 已知限制

- 会话标题取 `session/title` 事件，没有就取第一条用户发言前 48 字；都没有时
  显示「未命名」加 id 尾号。
- 消息数按导出器实际会写出的条数计算，和 ZIP 里的一致（不是原始事件数）。
- ZIP 用 store（不压缩），体积接近原始内容之和。
- 非图片文件只描述、不嵌入：官方导入器只还原它认得的图片。

### 许可

MIT，见 [LICENSE](LICENSE)。
