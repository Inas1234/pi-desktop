# Pi Desktop

Pi Desktop is a minimal, Windows-first desktop client for the
[Pi coding agent](https://pi.dev). It provides a focused graphical chat interface while keeping Pi
itself as the agent runtime.

Pi still owns model access, tools, extensions, provider integrations, queues, and JSONL session
files. The desktop app owns process lifecycle, protocol transport, credentials, and presentation.
There is no embedded Node backend and no second conversation database.

> Pi Desktop is currently an early v1 implementation. The core desktop workflow works, but the
> project is still under active development and has not reached a stable public release.

## What works today

### Projects and sessions

- Open multiple local projects and switch between them from the sidebar.
- Choose whether each project is trusted before Pi loads project-local settings, extensions,
  prompts, skills, or packages.
- Run one lazily started Pi RPC process per active project.
- Browse, search, create, open, rename, and recycle Pi's existing JSONL sessions.
- Load long transcripts in pages instead of copying the entire session into the WebView.
- Keep background projects running and stop settled, inactive processes after the configured idle
  timeout.

### Chat and agent activity

- Stream assistant text and reasoning into the conversation.
- Render completed messages as safe Markdown with raw HTML disabled.
- Display specialized tool cards for Bash, read, write, edit, grep, find, and list operations.
- Accumulate bounded tool-output tails without flooding the frontend.
- Show queue state, context usage, active model, thinking level, and connection state.
- Send prompts, steer an active run, queue a follow-up, attach images, or abort work.
- Recover once from an unexpected Pi process exit and request a frontend resync when needed.

### Commands and Pi extensions

- Type `/` in the composer to open slash-command autocomplete.
- Use desktop commands: `/new`, `/model`, `/settings`, and `/login`.
- Merge Pi extension commands, prompt templates, and skill commands into the same autocomplete.
- Navigate suggestions with Up/Down, complete with Tab or Enter, and dismiss with Escape.
- Support Pi extension UI requests for select, confirm, input, editor, notifications, status,
  widgets, titles, and editor-text updates.

### Models, credentials, and settings

- Select any model reported by Pi and change the active thinking level.
- Store supported API keys in Windows Credential Manager.
- Detect credentials already managed by Pi and report which source takes precedence.
- Launch Pi's native login flow in an external terminal for OAuth and more complex providers.
- Configure theme, reasoning visibility, Pi executable override, and idle timeout.
- Restore window state and respect the operating system's reduced-motion preference.

### Runtime and safety

- Discover `pi.cmd`, validate Pi 0.80.x compatibility, and allow a manual path override.
- Communicate through Pi's strict line-delimited JSON RPC mode.
- Correlate responses by request ID and tolerate unknown future fields and events.
- Coalesce streaming deltas at a maximum cadence of roughly 33 ms.
- Keep bounded RPC records, image attachments, and stderr diagnostics.
- Assign Pi and its child processes to a Windows Job Object for reliable cleanup.
- Use a restrictive Tauri capability set and Content Security Policy.
- Include no telemetry, analytics, or automatic updater.

## Deliberately out of scope for v1

Pi Desktop does not currently include an embedded editor, terminal, file explorer, package manager,
changes panel, session-tree navigator, fork/clone UI, export workflow, or automatic Pi installer.
Those features should not be added at the expense of the chat-first workflow or idle resource use.

## Technology

- [Tauri 2](https://v2.tauri.app/) and Rust 2024
- React 19 and strict TypeScript
- Vite 8
- Tailwind CSS 4 with small shadcn/Radix primitives
- Motion for React loaded through `LazyMotion`
- `useSyncExternalStore` for the frontend state boundary
- Vitest, Testing Library, Biome, Cargo test, and Clippy

## Requirements

- Windows 10 or Windows 11 x64
- Node.js 22 or newer
- pnpm 10
- Rust 1.88 or newer with a working Windows linker toolchain
- WebView2 Runtime, included with supported Windows installations
- `@earendil-works/pi-coding-agent` 0.80.x

For an MSVC Rust host, install Visual Studio's **Desktop development with C++** workload and a
Windows SDK. A complete MinGW/GNU Rust host also works for local development.

Install Pi with pnpm:

```powershell
pnpm add -g @earendil-works/pi-coding-agent
pi --version
```

Pi Desktop prefers `pi.cmd` on Windows. If Pi is not on `PATH`, select the executable manually in
Settings.

## Quick start

Install dependencies and start the full desktop application:

```powershell
pnpm install
pnpm tauri dev
```

The first Rust build can take a little while. Later launches should reuse Cargo's build cache.

Once the window opens:

1. Select **Open project**.
2. Choose a working directory.
3. Read the trust explanation and open the project as trusted or restricted.
4. Select a model if Pi does not already have one configured.
5. Start chatting or type `/` to open command autocomplete.

Running `pnpm dev` by itself only starts the browser frontend. That preview can display setup states,
but it cannot spawn or communicate with Pi because those capabilities live in Tauri/Rust.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send a prompt, steer an active run, or complete a slash command |
| `Alt+Enter` | Queue a follow-up |
| `Shift+Enter` | Insert a newline |
| `Escape` | Dismiss slash suggestions or abort the active run |
| `Up` / `Down` | Move through slash-command suggestions |
| `Tab` | Complete the selected slash command |
| `Shift+Tab` | Cycle the thinking level |
| `Ctrl+L` | Open the model picker |
| `Ctrl+K` | Open the command palette |
| `Ctrl+B` | Toggle the sidebar |

## Development commands

Use pnpm for all JavaScript and Tauri scripts. Do not create npm or Yarn lockfiles.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the browser-only Vite frontend |
| `pnpm tauri dev` | Start Vite, compile Rust, and launch the desktop app |
| `pnpm lint` | Run Biome checks |
| `pnpm typecheck` | Run strict TypeScript checks |
| `pnpm test` | Run frontend unit and component tests |
| `pnpm build` | Typecheck and build the production frontend |
| `pnpm rust:check` | Check the Rust desktop crate |
| `pnpm rust:test` | Run Rust library tests without the WebView desktop feature |
| `pnpm rust:lint` | Run Clippy with warnings denied |
| `pnpm check` | Run the complete frontend and Rust verification suite |

`pnpm rust:test` disables the desktop feature so protocol and session tests do not initialize
WebView2. This also avoids a GNU-host WebView2 loader issue in native test executables.

## Building the installer

Create a release build and current-user NSIS installer:

```powershell
pnpm tauri build
```

The installer is written below:

```text
src-tauri/target/release/bundle/nsis/
```

## Architecture

```text
React renderer
  |  typed Tauri commands + ordered Channel<AppEvent>
  v
Rust ProjectManager
  |-- project configuration and trust
  |-- Pi discovery and process lifecycle
  |-- JSONL framing, correlation, and stream batching
  |-- session offset index and transcript paging
  |-- Windows Credential Manager
  |-- Windows Job Object cleanup
  |
  |  stdin/stdout JSONL RPC
  v
Pi CLI process (one per running project)
  |-- models and providers
  |-- tools and extensions
  |-- queues and compaction
  `-- Pi-owned JSONL sessions
```

Rust is authoritative for process and protocol state. React consumes ordered events and immutable
snapshots through a small `useSyncExternalStore` store. The renderer does not parse Pi stdout,
manage child processes, or persist a duplicate transcript.

### Repository layout

```text
src/
  app.tsx                  App shell and global shortcuts
  components/              Conversation, composer, sidebar, tools, dialogs
  lib/bridge.ts            Typed Tauri command boundary
  lib/types.ts             Shared frontend protocol types
  lib/slash-commands.ts    Desktop and Pi command autocomplete
  stores/app-store.ts      Normalized frontend event reducer/store
  styles.css               Design tokens and application styling

src-tauri/
  src/commands.rs          Public Tauri command handlers
  src/manager.rs           Pi processes, RPC, batching, recovery, idle reaper
  src/sessions.rs          Session discovery, indexing, and paging
  src/config.rs            Atomic non-secret application configuration
  src/credentials.rs       Windows Credential Manager integration
  src/providers.rs         Supported provider environment-key registry
  src/windows_job.rs       Windows child-process tree cleanup
  capabilities/            Minimum Tauri window permissions
```

## Data, trust, and credentials

Pi session files remain in Pi's normal session directories and keep Pi's native tree format. The app
stores only non-secret preferences such as projects, trust choices, active sessions, theme, window
state, Pi path, and idle timeout.

Project trust controls whether Pi may load project-local settings, extensions, prompts, skills, and
packages. It does **not** add a second tool-approval layer or change Pi's execution semantics.

Simple API keys are stored as generic credentials under the `Pi Desktop` service in Windows
Credential Manager and injected into child-process environment variables. Pi Desktop never writes
or replaces `~/.pi/agent/auth.json`. If Pi already has credentials for a provider, Pi's own
credential source takes precedence.

## Performance goals

Release measurements should use a packaged build and a representative 200-message session:

- App shell without Pi: no more than 150 MB private working set.
- App plus one settled Pi process: no more than 250 MB.
- Idle CPU: no more than 1% averaged over 60 seconds.
- No more than 30 IPC/UI commits per second per project while streaming.
- Fewer than 300 rendered transcript/tool rows with a 10,000-entry fixture.
- No main-thread task above 50 ms during normal streaming.
- No unbounded memory growth during repeated switching or a 30-minute idle period.

These are release gates, not guarantees for debug builds.

## Troubleshooting

### Pi runtime not found

Confirm that Pi is installed and visible from the same terminal:

```powershell
where.exe pi.cmd
pi --version
```

If needed, open Settings and provide the full path to `pi.cmd`.

### `link.exe` not found

The selected MSVC Rust host cannot find a complete Visual C++ environment. Install the Visual
Studio C++ desktop workload and Windows SDK, then open a fresh terminal. Alternatively, use an
already configured GNU/MinGW Rust host.

### Port 1420 is already in use

Another Vite or Tauri development process is still running. Close the older development terminal or
desktop instance, then run `pnpm tauri dev` again.

### Vite works but Pi does not connect

Make sure the app was started with `pnpm tauri dev`, not only `pnpm dev`. The browser-only preview
cannot access Tauri commands.

## Contributing

Read [AGENTS.md](./AGENTS.md) before changing the project. It documents the architectural ownership
boundaries, performance constraints, coding conventions, and expected verification for changes.
