# Pi Desktop 0.2.0 preview

This preview makes Pi Desktop substantially smoother when several chats are active in one project.
You can move to another chat without aborting ongoing work, follow compact running/attention markers
in the sidebar, and reopen a working chat in place. Runtime concurrency remains bounded to the
selected chat plus at most three detached working chats per project.

Other highlights:

- faster warm startup from bounded session-summary and command caches;
- compact subagent fleet cards with per-agent details;
- credential and Pi-version checks moved away from the critical startup path;
- a jump-to-latest control anchored above the composer;
- row-local, two-step session deletion controls;
- contribution, conduct, security, issue, and pull-request guidance for the public repository.

Requirements:

- Windows 10 or Windows 11 x64
- Pi `0.80.x` installed and available as `pi.cmd`, or selected in Settings

Security notice: this preview installer is not Authenticode-signed because the project does not yet
have a trusted Windows signing identity. Verify the accompanying SHA-256 checksum before running
the installer. Windows SmartScreen may show an unknown-publisher warning.

See `CHANGELOG.md` and `README.md` for the complete scope and setup instructions.
