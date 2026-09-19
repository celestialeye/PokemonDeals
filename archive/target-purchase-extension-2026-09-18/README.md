# Target Purchase Extension Archive

Retired on 2026-09-18 at the user's direction.

This archive preserves the Target Chrome-extension approach while keeping it
disconnected from active project commands.

The complete build, live-trial, failure, and retirement analysis is in
[`LEARNINGS.md`](LEARNINGS.md).

## Browser cleanup

- Extension: `Target Purchase Monitor` version `0.1.0`
- Extension ID: `ebndeclalfemcolpdhiamhcbiakflgii`
- Removed from: `C:\Users\iwsco\AppData\Local\Google\Chrome\User\Default`
- Chrome retains an empty protected-settings tombstone for the removed ID; no
  extension or extension storage remains registered.
- Scheduler port `127.0.0.1:18765` was stopped.
- The stale simulated Chrome profile was moved under
  `runtime-artifacts/temp/`.

## Preserved material

- Original extension source under `extension/target-purchase/`
- Installer and localhost scheduler under `scripts/`
- Extension tests and Target HTML fixtures under `tests/`
- Design and implementation documents under `docs/superpowers/`
- Scheduler logs and browser-run evidence
- Pre-cleanup `README.md`, `package.json`, and `package-lock.json` under
  `snapshots/`

The active package scripts and README no longer expose this extension. Files in
this archive are historical and must not be run against a live retail session.
