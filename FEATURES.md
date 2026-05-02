# Control Panel Features

This document lists the features that are currently implemented in the codebase.

It is intentionally separate from `TODO.md`:
- `FEATURES.md` documents shipped behavior.
- `TODO.md` documents planned work, ideas, and fixes.

## Contents

- [At a Glance](#at-a-glance)
- [Secure Local Shell](#secure-local-shell)
- [AI Chat Experience](#ai-chat-experience)
- [Transcript Rendering](#transcript-rendering)
- [Model and Backend Management](#model-and-backend-management)
- [API and Integration Surface](#api-and-integration-surface)
- [Platform and Build Targets](#platform-and-build-targets)

## At a Glance

| Area | Included |
| --- | --- |
| Secure local shell | Password setup/login, bearer-authenticated protected routes, exact-origin request gating, encrypted saved chat data, zero-knowledge password vault, and backend health monitoring |
| AI chat workflow | Graph-threaded chats, lazy chat loading, background generation tasks, reconnectable streaming, reasoning blocks, per-chat tool-pack scope, inline tool-call rendering |
| Transcript UX | Message editing, regenerate-from-here, branching, raw-copy behavior, markdown rendering, code-block actions, colour previews |
| Model management | LM Studio configuration, built-in `llama.cpp` backend building/switching, HuggingFace GGUF search/download/delete/tokenizer install |
| Tuning and personalisation | Theme palettes, AI behavior settings, token-confidence display/history controls, title-generation settings |
| Integration surface | REST API, task endpoints, tool-pack discovery/reload, approval endpoints, MCP client loading/bridging, built-in MCP config tools |

The tool system ships with real bundled calculator and web-search packs plus the synthetic internal control-plane pack used for deferred discovery and schema loading. Additional packs can still be added locally or bridged in from MCP servers.

---

## Secure Local Shell

### Authentication and Stored Data

| Feature | What it does |
| --- | --- |
| First-run password bootstrap | The app starts with a password-setup flow when no password has been configured yet. |
| Session-based login | Logging in returns a bearer session token that gates protected `/api/*` and `/mcp` routes. |
| Session validation and logout | Existing bearer tokens can be validated, reused from `localStorage`, and explicitly revoked. |
| Origin / referer allowlist | Protected backend routes accept only requests whose `Origin` or `Referer` resolve to `http://127.0.0.1:8080`. |
| Encrypted saved chat data | Persisted chat payloads are stored as AES-256-GCM encrypted envelopes. |
| PBKDF2 password derivation | New panel auth setups use PBKDF2-HMAC-SHA256 at 600,000 iterations, with legacy 310,000-iteration setups transparently upgraded on successful login. |
| Panel reauthentication | Protected settings changes can require a fresh panel-password reauth token instead of relying on the long-lived app session alone. |
| Zero-knowledge password vault | The password manager has its own route-local lock screen, browser-side AES-256-GCM vault encryption, RAM-only vault keys, and a separate unlock flow from the main panel session. |
| BroadcastChannel vault sharing | Unlocked vault keys can be shared across live tabs in RAM only, while page refreshes and browser restarts relock the vault. |
| Idle vault relock | The app can automatically drop vault memory after a configurable panel-wide idle timeout. |
| Device-scoped PIN unlock | Individual browsers can register a local PIN-wrapped unlock slot that depends on a server-side pepper returned only after successful online PIN verification. |
| PIN lockout wipe | Repeated failed PIN attempts within the configured one-minute window delete that device slot until the master password is used again. |
| Login presentation | The login page uses an animated starfield background rather than a static screen. |

### App Shell and Reliability

| Feature | What it does |
| --- | --- |
| Multi-page shell | The app exposes dedicated Home, AI Chat, and Settings pages inside a shared shell. |
| Collapsible sidebar | The main sidebar can be collapsed to free horizontal space. |
| Collapsible AI chat group | The sidebar chat section can be expanded/collapsed independently. |
| Quick new-chat action | A compact new-chat button remains available when the sidebar is collapsed. |
| Backend health polling | The frontend continuously checks `/health` to detect when the backend becomes unavailable. |
| Retry / reconnect modal | If the backend drops, the UI shows a reconnect flow instead of silently failing. |

### Bundled Tool Packs

| Feature | What it does |
| --- | --- |
| Bundled calculator pack | Ships schema-first native math tools, including a typed calculator and a batch fallback worker. |
| Bundled web-search pack | Ships a real indexed web-search subsystem instead of example/demo HTTP tools. |
| Bundled file-reader pack | Ships a prompt-gated native local text file reader with line and character limits. |
| Web search ranking and fallback | `search_web` ranks indexed pages with SQLite FTS5 and can fall back to live web results when the local index misses. |
| Stored result opening | `open_result` returns cleaned indexed text, metadata, and discovered links by `doc_id`. |
| Live fetch and indexing | `fetch_url` fetches live pages, obeys robots/sitemaps, canonicalises URLs, deduplicates content, and updates the local index. |
| Related-page discovery | `related_results` returns linked and same-host neighbors for already indexed pages. |
| Search health visibility | `search_status` reports index counts, queue depth, worker state, and storage details. |

---

## AI Chat Experience

### Chat Structure and Persistence

| Feature | What it does |
| --- | --- |
| Multiple chats | The app stores and switches between many conversations, not just one active thread. |
| Lazy chat loading | Chat summaries are loaded first; full chat graphs are loaded on demand when a specific chat is opened. |
| Persistent current chat | The selected chat is tracked and restored through the shared chat store. |
| Inline rename | Chat titles can be renamed directly from the sidebar list. |
| Pin / unpin | Chats can be pinned so they stay separated from regular chats in the sidebar. |
| Chat deletion | Chats can be deleted from the sidebar and from backend storage. |
| AI-generated titles | New chats can receive an automatically generated title after the first user turn, using configurable title-model settings. |
| Per-chat model persistence | Each chat can remember its selected model independently from the global default. |
| Per-chat tool-pack scope | Each chat stores its own enabled tool-pack IDs separately from other chats. |

### Conversation Graph Instead of a Flat Transcript

| Feature | What it does |
| --- | --- |
| Message graph | Conversations are stored as a graph with parent/child relationships instead of a single irreversible linear log. |
| Branch from any message | A new thread can be created starting from any existing message. |
| Sibling navigation | Messages with alternate continuations expose back/forward controls to move between thread variants. |
| Regenerate from a chosen turn | Regeneration can delete the current assistant branch beneath a user message and generate a new continuation from that same turn. |
| Subtree deletion | Entire branches can be removed from the conversation graph. |
| Single-node splice delete | Shift-delete removes just the selected node while preserving the rest of the thread when that operation is valid. |

### Composer and Attachments

| Feature | What it does |
| --- | --- |
| Contenteditable composer | The chat input is a rich contenteditable surface rather than a plain textarea. |
| Keyboard send shortcut | `Ctrl+Enter` / `Cmd+Enter` sends the current message. |
| Replyless send shortcut | `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` adds the user turn without immediately starting a model reply. |
| Auto-resizing input | The composer grows/shrinks with content instead of locking to a fixed height. |
| Multi-file upload | The toolbar upload action accepts multiple files in one selection. |
| Paste-to-attach | Pasted files and images are converted into inline attachments. |
| Inline attachment chips | Attachments appear directly inside the composer, in message order, instead of in a detached list. |
| Inline image previews | Image attachments show a preview thumbnail before sending. |
| File chips for non-images | Non-image files show filename, extension/type, and size. |
| Attachment removal | Inline attachments can be removed with their built-in remove control or via keyboard interactions. |
| Multimodal user payloads | Image attachments are converted into multimodal message blocks for models that support image input. |
| Text extraction from non-image attachments | Non-image attachments are decoded as text when possible and folded into the model-facing context. |

### Generation, Streaming, and Recovery

| Feature | What it does |
| --- | --- |
| Task-based generation | Message generation is created as a backend-owned task rather than being tied to one in-memory frontend stream. |
| Background generation | A generation can continue on the backend even if the current page instance goes away. |
| SSE streaming | The UI receives generation output over server-sent events and renders it incrementally. |
| Stop / cancel | The send button becomes a stop button while generation is active and can cancel the active task. |
| Reconnect to active tasks | On page return or refresh, the chat page checks for a running task for the current chat and reattaches to it. |
| Chunk replay on reconnect | Reattached streams replay buffered chunks first, then continue live. |
| Completed-result recovery | If a task already finished while the user was away, the frontend reloads the backend-saved result into the chat. |
| Partial-response error preservation | If a stream fails after partial text, reasoning, or tool events have already arrived, the partial assistant message is kept and the error is appended inline instead of discarding the response. |
| Auto title trigger | After the first user message completes, the app can asynchronously request a generated chat title. |

### Reasoning and Tool Visibility

| Feature | What it does |
| --- | --- |
| Reasoning extraction | The app can parse reasoning emitted natively or embedded inside `<think>...</think>` blocks. |
| Collapsible Thinking block | Assistant reasoning is displayed in a dedicated collapsible block instead of being mixed into the visible answer text. |
| Markdown-rendered Thinking content | Reasoning text inside the Thinking block uses the same Markdown/callout/code renderer as normal assistant output. |
| Inline tool-call rendering | Tool executions are rendered inside assistant messages when configured tools are invoked, with expandable input/output details. |
| Live tool execution events | Tool-call UI can appear during streaming, not only after the final message has finished. |
| In-chat approval actions | Pending tool approvals can be approved or denied directly from the chat UI. |
| Token logprob capture | Token confidence data is stored alongside assistant messages when the backend/model provides it. |

### Message Actions and Copy Behavior

| Feature | What it does |
| --- | --- |
| Inline message action menu | Hovering a message exposes actions for thread navigation, branching, editing, regenerating, deleting, and copying. |
| Edit user messages | Editing a user message creates a sibling branch and can trigger a new response from that edited turn. |
| Edit assistant messages | Editing an assistant message updates the selected branch without forcing another generation. |
| Raw message copy | Copying a full message preserves stored raw content, including reasoning when present. |
| Partial transcript copy | Partial selections are converted from rendered HTML back into Markdown-like text instead of copying UI chrome. |
| Full-selection HTML copy | The clipboard also receives an HTML representation for rich-paste targets. |

### Scrolling and Live Context Awareness

| Feature | What it does |
| --- | --- |
| Live auto-scroll | The transcript follows new output automatically while the user is at the bottom. |
| User-controlled scroll detachment | If the user scrolls upward, the app stops forcing scroll-to-bottom during streaming. |
| Scroll-to-bottom button | A dedicated button appears when the user is detached from the live bottom of the transcript. |
| Live context meter | The toolbar shows a live backend-counted `used / max` prompt-token count for the current conversation. |
| Context availability warnings | The toolbar can flag unknown model context windows and cases where exact token counting is temporarily unavailable. |
| Attachment-aware token counting | Attachments contribute to the token count instead of being ignored. |
| System-prompt-aware token counting | Global system-prompt content is included in the token count. |
| Reasoning/tool-aware token counting | Stored reasoning blocks and tool-call records are included in the token count. |
| Context pressure warnings | The context meter changes state at 50% usage and again at 90% usage. |

---

## Transcript Rendering

### Markdown and Rich Text Processing

| Feature | What it does |
| --- | --- |
| GitHub-flavoured Markdown | The renderer supports core Markdown plus common GFM constructs such as tables, task lists, autolinks, and fenced code blocks. |
| Discord-style extras | Spoilers, mentions, and timestamps are parsed and rendered. |
| Obsidian-style extras | Wikilinks, highlights, and callout/admonition-style formatting are supported. |
| Named callout presets | Obsidian-style `warning`, `caution`, `danger`, `error`, `success`, `check`, and related callouts render with icons and themed styling. |
| Safe inline HTML handling | Generated HTML is filtered so allowed markup can render without opening the door to arbitrary unsafe tags. |

### Code Blocks and Developer-Focused Rendering

| Feature | What it does |
| --- | --- |
| Syntax-highlighted fenced code blocks | Code blocks render with language-aware styling when a language tag is present. |
| Code block header bar | Each fenced block includes a dedicated header area instead of appearing as raw preformatted text only. |
| Copy-code button | Code blocks can be copied directly from the transcript. |
| Collapse / expand | Code blocks can be collapsed to reduce transcript height. |
| Inline code styling | Inline code spans render distinctly from surrounding prose. |

### Colour and Confidence Rendering

| Feature | What it does |
| --- | --- |
| Colour preview blocks | Recognised colour literals render with a visible colour preview. |
| Supported colour formats | The renderer recognises `#rrggbb`, `#rrggbbaa`, and `rgb(r, g, b)` forms. |
| Token-confidence highlighting | Assistant text can be wrapped with high/medium/low confidence classes based on token logprobs. |
| Probability tooltip | Highlighted tokens show an approximate probability tooltip on hover. |
| Configurable visibility | High-, medium-, and low-confidence token display can each be toggled independently. |
| Confidence-to-history controls | The same confidence bands can also be selectively injected back into chat history for the model to see. |

### Message-Embedded Attachments

| Feature | What it does |
| --- | --- |
| Inline image rendering | Image attachments render directly inside the message body. |
| Inline non-image rendering | Non-image attachments render with icon/type/name/size metadata instead of appearing as a detached blob. |
| Stored assistant metadata rendering | Saved reasoning blocks, tool calls, and token logprobs all contribute to the displayed transcript. |

---

## Model and Backend Management

### LM Studio Support

| Feature | What it does |
| --- | --- |
| Configurable LM Studio URL | The Settings page lets the user point the app at a specific LM Studio server address. |
| LM Studio connectivity test | The UI can actively test the configured LM Studio endpoint and show its status. |
| LM Studio model listing | Available LM Studio models are exposed through the shared model list and the dedicated LM Studio models endpoint. |

### Built-In `llama.cpp` Management

| Feature | What it does |
| --- | --- |
| Full backend restart / stop controls | The Settings page can restart or stop the entire backend process, including the managed `llama.cpp` router. |
| Managed local `llama.cpp` runtime | The app can run against its own managed `llama-server` setup, not only external servers. |
| Backend preference selector | The user can choose `auto`, `cpu`, `cuda`, `rocm`, or `vulkan` as the preferred backend. |
| Hardware-based backend suggestions | When faster supported GPU hardware is detected, the app can suggest building a better backend. |
| Guided build flow | Suggested backends can be launched into Settings and built from there. |
| Build / rebuild from Settings | Backends can be built and rebuilt directly from the web UI. |
| Live build progress | The build UI shows percent progress, phase text, ETA-style estimates, and recent build-log output. |
| Backend removal | Built backends can be removed from disk through the Settings UI. |
| Suggestion dismissal | Hardware suggestions can be dismissed permanently. |
| Managed model reload | Settings changes can trigger a managed model/router reload so they apply without restarting the whole app. |
| Router / pool status endpoint | Backend status for the managed `llama.cpp` pool is exposed through the API. |

### `llama.cpp` Tuning Controls

| Feature | What it does |
| --- | --- |
| Flash Attention toggle | Enables or disables `llama.cpp` Flash Attention behavior. |
| KV cache reuse toggle | Enables or disables cache reuse across compatible requests. |
| Eval batch size control | Exposes evaluation batch-size tuning. |
| Context size override | Exposes a configurable `llama.cpp` context size setting. |
| Keep-alive / unload timing | The user controls how long models stay loaded before being unloaded. |
| Concurrent generation toggle | The managed router can be configured for multi-request or single-request behavior. |
| Parallel request slots | The number of concurrent request slots can be tuned. |
| Max loaded models | The maximum number of simultaneously loaded models can be tuned. |
| GPU layer count | GPU offload depth is configurable. |
| KV cache quantisation | Cache type can be switched between supported quantisation options. |
| CPU generation and batch threads | Separate thread counts can be set for token generation and batch work. |
| Sampling controls | `Top-P`, `Min-P`, and repetition-penalty settings are exposed. |
| Source tag selection | The `llama.cpp` source tag/version can be set from the UI. |

### HuggingFace GGUF Model Manager

| Feature | What it does |
| --- | --- |
| HuggingFace model search | The Settings page can search HuggingFace for candidate GGUF models. |
| Search sorting | Results can be sorted by downloads, likes, trending, or created date. |
| Capability filtering | Search results can be filtered for image-support and audio-support signals. |
| Model file inspection | The app can query a model's GGUF, mmproj, and tokenizer files before download. |
| Quant picker | When a model exposes multiple GGUF files, the UI lets the user choose which quant to download. |
| Automatic mmproj discovery | Vision projection files are auto-detected and included when available. |
| Automatic tokenizer discovery | Tokenizer files are auto-detected and included when available. |
| Structured install directories | Downloads are stored in an organised directory structure rather than a flat dump. |
| Download progress and cancel | Downloads are asynchronous, pollable, and cancellable. |
| Local model inventory | Downloaded local models are listed in the Settings UI. |
| Local model deletion | Downloaded models can be removed from disk from the UI. |
| Tokenizer backfill | If a local model is missing tokenizer files, they can be installed later without redownloading the model. |
| Local model metadata badges | Local entries can show whether tokenizer files exist, whether vision/mmproj files exist, and whether the model is currently loaded. |
| Context-length display | Local entries show known context length where available. |

---

## API and Integration Surface

### REST API Coverage

The backend exposes API groups for:
- Authentication setup, login, logout, and validation
- Chat summary CRUD and per-chat detail CRUD
- Legacy chat endpoints, prompt token counting, and task-based generation endpoints
- Model listing and local-model deletion
- LM Studio model listing
- Settings read/write
- `llama.cpp` backend selection, building, logs, reloads, and pool status
- HuggingFace search, metadata, file listing, download tracking, cancellation, and tokenizer installation
- Tool-pack discovery, reload, catalog search, and approval resolution
- MCP aggregation and config reload

### Tooling Infrastructure

| Feature | What it does |
| --- | --- |
| Runtime tool-pack directories | The app creates system and user tool-pack directories at startup. |
| `data/tooling.json` state | Tool-system state such as disabled pack IDs is stored in a dedicated tooling config file. |
| Manifest-driven pack format | Tool packs are defined by `pack.json` plus per-tool JSON manifests, rather than being hardcoded into the frontend. |
| Embedded bundled tool packs | Bundled system packs are embedded into the backend binary at build time and synced into runtime `toolpacks/` on startup. |
| Pack discovery and hot reload | Tool packs can be discovered and reloaded without rebuilding the app. |
| Settings pack visibility | The Settings page shows discovered packs, executor types, tool counts, and sandbox health. |
| Per-chat pack enablement | Each chat can enable or disable discovered packs from the toolbar. |
| Approval workflow | Tool executions can pause for approval, with list/approve/deny endpoints and inline chat actions. |
| Multiple executor backends | The execution layer supports native, HTTP, sandbox, and MCP-backed tools. |
| Strict input-schema validation | Tool arguments are validated against each tool's declared JSON schema before execution, and invalid calls fail fast as failed tool events. |
| Internal control-plane pack | Fresh installs include a synthetic pack for deferred tool-catalog search and schema loading. |
| Bundled calculator pack | Fresh installs include a calculator pack with a native scientific calculator and a sandboxed batch-math fallback tool. |
| Bundled web-search pack | Fresh installs include a web-search pack with SQLite FTS5 indexing, robots/sitemap-aware fetching, canonicalisation, deduplication, snippets, related-result lookup, and subsystem status reporting. |
| Current shipped tool state | The repository ships the internal control-plane pack plus bundled calculator, web-search, and file-reader packs out of the box; additional packs can be added locally or via MCP. |

### MCP Support

| Feature | What it does |
| --- | --- |
| `data/mcp.json` configuration | MCP clients are loaded from a dedicated on-disk configuration file. |
| HTTP MCP clients | Remote MCP servers can be connected over HTTP. |
| stdio MCP clients | Local MCP servers can be spawned and connected over stdio. |
| Live reload | MCP configuration can be reloaded without rebuilding the app. |
| MCP virtual packs | Live MCP tools can be bridged into the tool system as opt-in virtual packs. |
| Aggregated tool list | Tools from live MCP clients are collected and exposed through the API in a single merged list. |
| Server-qualified tool names | Aggregated MCP tool names are prefixed so tools from different servers do not collide. |
| JSON-RPC MCP endpoint | The backend exposes an `/mcp` JSON-RPC surface. |
| Built-in MCP config tools | The app exposes built-in `get_config` and `set_config` MCP tools alongside externally loaded MCP tools. |
| Empty default MCP state | Fresh installs start with an empty `mcpServers` object, so no external MCP tools are available until configured. |

### Chat Tool Pipeline

| Feature | What it does |
| --- | --- |
| Tool-call parsing from LM Studio | The LM Studio backend can parse supported model tool-call output and hand it to the tool system. |
| Tool-call parsing from managed `llama.cpp` | The managed `llama.cpp` backend can do the same for supported tool-calling models. |
| Tool scope on generation tasks | Generation requests carry the current chat's enabled pack scope. |
| Transcript-visible execution records | Tool executions are streamed back into the chat transcript with input, output, status, and approval details. |
| Approval-aware task states | A generation task can enter a `waiting_approval` state until the user resolves a pending tool action. |
| Malformed tool-call recovery | If a model emits malformed tool-call argument JSON, the backend turns it into a failed tool event instead of aborting the whole response. |
| Bundled calculator tools | Out-of-the-box installs provide real calculator capabilities via a native scientific calculator and a sandboxed batch-math tool. |

---

## Platform and Build Targets

| Target | Status |
| --- | --- |
| Linux | Primary development and build target |
| Windows | Build output exists in the current CMake/build flow |
| ARM | Optional ARM binary can be produced when the cross-toolchain and dependencies are available |
