# AGENTS.md

This file applies to the entire repository. It is the implementation guide for coding agents and
contributors working on Pi Desktop.

## Product intent

Pi Desktop is a Windows-first, chat-focused graphical client for the Pi coding agent. The app should
feel terminal-native, restrained, and fast while remaining easier to navigate than a terminal UI.

Preserve these non-negotiable decisions:

- Pi is the agent runtime. Do not reimplement its model, provider, tool, extension, queue, or session
  systems in JavaScript or Rust.
- Rust owns Pi process lifecycle, JSONL RPC, sessions, credentials, and durable non-secret app state.
- React is a lightweight renderer over typed commands and ordered events.
- Use the user's installed Pi CLI. Do not bundle Pi or add a persistent Node backend.
- Preserve Pi's JSONL sessions and directory resolution. Do not introduce a second conversation
  database.
- Windows 10/11 x64 is the only packaged v1 target.
- Optimization matters. Avoid background polling, unbounded buffers, duplicate transcript copies,
  large dependency additions, and animation work during token streaming.
- No telemetry, analytics, or automatic updater.
- Use pnpm. Do not use npm or Yarn and do not create another lockfile.

## Read before editing

Start with the smallest relevant set of files:

- `README.md` for product behavior, setup, and current scope.
- `src/lib/types.ts` for the frontend protocol and state types.
- `src/lib/bridge.ts` for the typed Tauri command boundary.
- `src/stores/app-store.ts` for event reduction and frontend state ownership.
- `src-tauri/src/models.rs` for serialized Rust models and `AppEvent`.
- `src-tauri/src/commands.rs` for public Tauri handlers.
- `src-tauri/src/manager.rs` for Pi process and RPC behavior.
- `src/styles.css` for design tokens and component layout.

Do not scan generated output or dependency trees unless the task requires them. In particular, avoid
editing `dist/`, `src-tauri/gen/`, `src-tauri/target/`, `node_modules/`, or TypeScript build-info
files.

## Architecture and ownership

### Rust is authoritative

`ProjectManager` maintains one lazily started Pi process per running project. Rust is responsible
for:

- discovering and validating the Pi executable;
- applying project trust through Pi RPC launch flags;
- spawning Pi with the project directory as `cwd`;
- hiding child consoles and assigning Windows Job Objects;
- framing stdout by raw LF boundaries and stripping an optional trailing CR;
- correlating command responses by generated IDs;
- tolerating unknown future events and fields;
- bounding RPC records, attachments, stderr, and tool-output tails;
- batching adjacent streaming updates at no more than roughly 33 ms;
- using `agent_settled`, not `agent_end`, when deciding whether work is idle;
- preserving queued work, active tools, retry/compaction, and extension dialogs;
- indexing and paging Pi-owned sessions;
- persisting non-secret app configuration atomically;
- storing API keys in Windows Credential Manager.

Do not move these responsibilities into React.

### React renders normalized state

The frontend uses `useSyncExternalStore` through `src/stores/app-store.ts`. React is responsible for:

- invoking typed commands through `src/lib/bridge.ts`;
- receiving ordered `AppEvent` values;
- detecting sequence gaps and requesting/requiring resync behavior;
- reducing Pi events into immutable project runtime snapshots;
- rendering the sidebar, conversation, tool cards, composer, dialogs, and settings;
- keeping only the active transcript page and bounded render state in the WebView.

Do not add Redux or another broad state framework without a measured need. Avoid mirroring Rust
process state in unrelated local component state.

### IPC changes cross several files

When adding or changing a Tauri command:

1. Update Rust input/output models in `src-tauri/src/models.rs` when needed.
2. Implement manager behavior before exposing it from `src-tauri/src/commands.rs`.
3. Register the command in `src-tauri/src/lib.rs`.
4. Add or update the typed wrapper in `src/lib/bridge.ts`.
5. Update TypeScript types in `src/lib/types.ts`.
6. Route stateful behavior through `src/stores/app-store.ts`.
7. Add focused Rust and/or frontend tests.

Keep serde naming and Tauri argument names consistent. Rust event variants use snake-case tags with
camel-case fields.

## Repository map

```text
src/
  app.tsx                  Shell, setup states, global shortcuts
  components/
    composer.tsx           Input, queue behavior, slash autocomplete
    conversation.tsx       Virtualized transcript surface
    message-item.tsx       Assistant/user/reasoning rendering
    tool-card.tsx          Specialized and generic tool renderers
    sidebar.tsx            Projects and Pi sessions
    extension-dialog.tsx   Pi extension UI requests
    settings-dialog.tsx    App, project, Pi, and credentials settings
  lib/bridge.ts            Tauri invoke/channel boundary
  lib/slash-commands.ts    Desktop commands merged with Pi commands
  lib/types.ts             Shared frontend models
  stores/app-store.ts      External store and event reducer
  styles.css               Tokens and all application CSS

src-tauri/src/
  commands.rs              Tauri command surface
  config.rs                Atomic non-secret app configuration
  credentials.rs           Windows Credential Manager
  diagnostics.rs           Pi discovery and version diagnostics
  manager.rs               Processes, RPC, batching, recovery, idle reaper
  models.rs                Serializable models and events
  providers.rs             Provider environment-key registry
  sessions.rs              Session resolution, metadata, offsets, paging
  windows_job.rs           Windows process-tree ownership
```

## Development commands

Run commands from the repository root.

```powershell
pnpm install
pnpm tauri dev
```

Use these verification commands:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm rust:check
pnpm rust:test
pnpm rust:lint
pnpm check
```

Choose verification proportional to the change:

- Documentation-only: inspect Markdown rendering and links; no full build is required.
- CSS-only: `pnpm lint`, `pnpm typecheck`, and a visual check at the normal Tauri window size.
- React/TypeScript: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Rust behavior: the relevant Rust test plus `pnpm rust:check` and `pnpm rust:lint`.
- Cross-boundary or release work: `pnpm check` and a Tauri smoke launch.

Do not leave background Vite, Tauri, Pi, or test processes running after verification. Track and stop
only processes started by the current task; never kill every process listening on a shared port.

## Frontend conventions

- TypeScript is strict. Do not use `any` to bypass protocol modeling.
- Prefer small function components and derived values over effect-driven mirrored state.
- Keep mutable app state in `app-store.ts`; keep ephemeral interaction state in the component that
  owns it.
- Reuse `src/components/ui/` primitives and existing Radix dependencies before adding packages.
- Keep dependency additions rare and explain their bundle/runtime cost.
- Lazy-load settings, command palette, model picker, Markdown, and motion features where practical.
- During streaming, render lightweight pre-wrapped text. Parse Markdown only after completion.
- Never enable raw HTML in Markdown.
- Do not animate individual tokens, progress loops on inactive rows, or other continuous idle UI.
- Respect reduced motion through the existing `MotionConfig` and CSS media query.
- Maintain keyboard navigation, focus restoration, labels, roles, and visible focus states.
- Slash-command autocomplete must always include desktop commands and merge tolerant Pi-provided
  extension, prompt, and skill commands.
- Treat incoming Pi values as untrusted/tolerant data even when TypeScript declares a narrower type.

## Visual conventions

The UI is deliberately terminal-esque, not decorative.

- Use the shared variables at the top of `src/styles.css`.
- Preserve the monochrome canvas/surface hierarchy.
- Reserve blue, green, yellow, and red for semantic information, success, warning, and failure.
- Use hairline borders, compact radii, and no drop shadows or gradients.
- Prefer spacing and typography for hierarchy instead of nested cards.
- Keep the centered conversation/composer width bounded and the sidebar compact.
- Use the monospace stack already defined on `:root`.
- Avoid globally increasing density or font size to solve one local component problem.
- Test both light and dark themes and a narrow window when changing layout.

## Rust and RPC conventions

- Keep public errors actionable and redact secrets before logging or surfacing diagnostics.
- Avoid `unwrap`/`expect` on user files, RPC data, environment values, and process output.
- JSONL framing must operate on byte-level LF boundaries; do not use Unicode line splitting.
- Preserve embedded Unicode separators such as U+2028 and U+2029.
- Strip only an optional CR immediately before LF.
- Keep record and image size limits explicit.
- Unknown Pi events and future session entries should not crash or invalidate the entire stream.
- Immediate boundaries such as errors, completion, dialogs, and process exits must flush pending
  batched deltas first.
- Never decide idleness from `agent_end`; wait for `agent_settled` and all other blockers to clear.
- Every spawned Pi process and child tree must remain owned by the Windows Job Object.
- Session deletion must remain recoverable through the Windows Recycle Bin.
- Do not write to or replace Pi's `~/.pi/agent/auth.json`.
- Zeroize credential material when practical and never include secrets in serialized app config.

## Sessions and trust

Pi's own session files are the source of truth. Preserve Pi's environment/project/global/default
session-directory precedence and tolerate future entry types.

Initial transcript loading is capped at the newest 200 entries. Older entries are prepended in pages.
Do not introduce an eager full-session read in React or a permanent transcript copy in app config.

Project trust permits project-local Pi resources. It does not mean “approve every tool,” and the UI
must never describe it that way. Tool execution remains faithful to Pi's configured behavior.

## Performance constraints

Before accepting a convenient abstraction, consider idle CPU, private working set, bundle size,
event frequency, and retained transcript data.

- Keep streaming IPC/UI commits at or below 30 per second per project.
- Keep rendered transcript/tool rows below 300 for very large sessions through virtualization.
- Avoid main-thread work above 50 ms during normal streaming.
- Keep stderr, tool output, RPC records, and in-memory diagnostics bounded.
- Avoid timers in React. Rust's idle reaper and batching intervals are the intended background loops.
- Do not parse completed Markdown repeatedly when unrelated state changes.
- Do not mount hidden heavyweight panels or dialogs permanently.

## Testing expectations

Add regression coverage near the changed behavior.

Frontend tests should cover, as applicable:

- event ordering and sequence-gap behavior;
- immutable store transitions;
- slash-command filtering and keyboard behavior;
- message/tool lifecycle states;
- Markdown safety;
- focus restoration and reduced motion;
- session, model, queue, and extension-dialog interactions.

Rust tests should cover, as applicable:

- fragmented UTF-8 and LF/CRLF framing;
- malformed, oversized, and unknown records;
- response correlation and timeout cleanup;
- secret redaction;
- session-directory precedence and unknown entries;
- bounded paging and indexing;
- process exit, restart, suspension, and cleanup behavior.

Prefer focused deterministic tests. Use a fake Pi executable for process integration behavior rather
than depending on the user's providers or credentials.

## Security rules

- Keep Tauri capabilities minimal and scoped to the main window.
- Do not relax the CSP broadly to fix a local loading issue.
- Do not expose arbitrary shell execution as a frontend command.
- Validate project IDs and paths in Rust before acting.
- Treat extension text, tool output, Markdown, and session contents as untrusted display data.
- Never print, snapshot, commit, or transmit API keys and provider tokens.
- External OAuth and cloud setup should continue through Pi's native login flow.

## Scope discipline

V1 intentionally excludes an embedded editor/terminal, file explorer, package management, complete
tree/fork/clone parity, exports, and a dedicated changes panel. Do not expand into these areas unless
the task explicitly requests it and the architecture/performance cost is understood.

Preserve unrelated user changes. Do not run destructive Git or filesystem commands to make a patch
easier. Generated artifacts should not be hand-edited.

## Definition of done

A change is complete when:

- behavior matches the user-facing request;
- Rust/React ownership boundaries remain intact;
- errors and empty states are understandable;
- keyboard and reduced-motion behavior still work;
- resource use stays bounded;
- relevant tests cover the regression or new behavior;
- proportional checks pass;
- documentation is updated when setup, commands, architecture, or behavior changed;
- no task-started development processes are left running.
