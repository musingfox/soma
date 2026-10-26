# soma

## Where things are

- Design, decisions and milestones: `ARCHITECTURE.md`. Task cards: the Obsidian vault and project named in `.obsidian.yaml`, under `pm/soma/tasks/`.
- Everything is written in English: code, comments, commit messages, docs and task cards. `ARCHITECTURE.md` and the older cards are still in Traditional Chinese until they are translated; write new or changed text in English.

## prod runs from this working tree

- The launchd agent `dev.musingfox.soma` runs `bin/soma` from this repo, so an edit here takes effect at prod's next restart. This holds until the `resident-service` card moves prod to a release under `~/.local/share/soma/releases/current`.
- Do not restart or unload prod (`launchctl kickstart` / `bootout`) and do not open prod's db `~/.local/share/soma/soma.sqlite` without asking. prod's log is `~/Library/Logs/soma.log`.
- Installing or reloading the LaunchAgent (`launchctl bootstrap`) is blocked by auto mode; ask the human to run it in their own terminal.

## Running dev

```sh
SOMA_CONFIG=~/.config/soma/dev.json PATH=~/.local/share/fnm/node-versions/v24.13.0/installation/bin:$PATH node src/main.ts
```

Without `SOMA_CONFIG`, soma reads prod's config; while prod is up that run fails on the db lock. `dev.json` has its own db and no Telegram, because one bot cannot be polled by two processes.

## Tests

- Smoke scripts (`npm run smoke:*`) talk to a real herdr. Point `HERDR_SOCKET_PATH` at a test session, never `fleet`: that is prod's hangar.
- `.githooks/pre-commit` runs `npm run lint` and `npm test` (about 30 s); `.githooks/commit-msg` enforces Conventional Commits.
