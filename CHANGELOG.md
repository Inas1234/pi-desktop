# Changelog

All notable changes to Pi Desktop are documented here.

## 0.2.0 - 2026-07-25

Second Windows preview focused on responsive multi-session work and lower startup latency.

### Added

- Keep up to three bounded background Pi processes alive for chats that are still working while a
  different chat is selected.
- Show per-session running and attention states and restore background extension requests when a
  chat is reopened.
- Detect subagent tool/custom-message payloads and present compact fleet summaries with focused
  per-agent detail views.
- Persist bounded, derived session-summary and command caches for a faster warm start without
  copying transcripts into app configuration.
- Add public contribution guidance, community standards, issue forms, and a pull-request template.

### Changed

- Make new-session and session-switch transitions immediate in the UI while Rust safely reconciles
  active, detached, and settled Pi runtimes.
- Move credential checks off the startup path and avoid launching Pi solely to read a standard
  global package version.
- Anchor the jump-to-latest control directly above the composer and keep session deletion controls
  attached to the session being deleted.

### Distribution note

The `0.2.0` installer remains unsigned. Verify the published SHA-256 checksum before running it;
Windows SmartScreen may show an unknown-publisher warning.

## 0.1.0 - 2026-07-19

First preview release.

### Included

- Windows-first Tauri desktop client for Pi 0.80.x.
- Multi-project chat, session paging, models, thinking levels, images, queue control, and recovery.
- Safe completed Markdown and bounded adaptive rendering for built-in and extension tools.
- Pi extension commands, UI requests, widgets, notifications, and displayable custom messages.
- Pi package listing, catalog browsing, installation, removal, updates, cancellation, and reloads.
- Windows Credential Manager integration and native Pi login/configuration flows.
- Bounded JSONL framing, streaming batches, session indexes, diagnostics, and process trees.

### Distribution note

The `0.1.0` installer is an unsigned preview build. Verify the published SHA-256 checksum before
running it. A trusted Authenticode certificate is required before promoting a later build to a
stable public release.
