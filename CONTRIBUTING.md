# Contributing to Pi Desktop

Thanks for helping improve Pi Desktop. Bug reports, focused feature proposals, documentation fixes,
tests, and implementation pull requests are welcome.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use a private GitHub security advisory for vulnerabilities; follow [SECURITY.md](./SECURITY.md).
- Keep proposals within the chat-focused scope described in [README.md](./README.md).
- Read [AGENTS.md](./AGENTS.md) before changing code. Its Rust/React ownership boundaries,
  performance limits, security rules, and test expectations apply to every contribution.

For a substantial feature or architectural change, open an issue first so scope and tradeoffs can be
agreed before implementation.

## Local development

Pi Desktop targets Windows 10/11 x64. Install Node.js 22+, pnpm 10, Rust 1.88+, a Windows linker
toolchain, WebView2, and Pi 0.80.x. Then run:

```powershell
pnpm install
pnpm tauri dev
```

Use pnpm only. Do not add an npm or Yarn lockfile.

## Making a change

1. Fork the repository and create a focused branch.
2. Preserve Pi as the agent runtime and Rust as the authority for processes, RPC, sessions,
   credentials, and durable state.
3. Add deterministic regression coverage near changed behavior.
4. Update documentation when behavior, setup, architecture, or commands change.
5. Run `pnpm check` before submitting a pull request.

For CSS-only work, `pnpm lint`, `pnpm typecheck`, and a visual check in light, dark, and narrow
layouts are sufficient. Rust, cross-boundary, and release changes require the broader checks listed
in [AGENTS.md](./AGENTS.md).

## Pull requests

Keep pull requests narrow and explain the user impact, root cause, implementation approach, and
verification performed. Mention performance or security effects when relevant. Do not include API
keys, provider tokens, private session contents, local project paths, generated build output, or
unrelated formatting changes.

By contributing, you agree that your contribution is licensed under the repository's
[MIT License](./LICENSE).
