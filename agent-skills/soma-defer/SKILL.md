---
name: soma-defer
description: Hand timed work to soma, the human's assistant service, so this session does not have to stay open for it. Use when the human asks for something to be done at a later time (at 14:00, tomorrow morning, in two hours), or wants work done after they close this session. At that time soma gives this session the instruction as a new prompt, resuming the session if it is closed.
allowed-tools: Bash(sh ${CLAUDE_SKILL_DIR}/register.sh *)
---

# Hand timed work to soma

soma is the human's assistant service. It can send this session an instruction at a later time, as a new prompt. If the session is closed by then, soma resumes it first. Nobody has to keep the session open to wait.

## When to use it

- The human asks for work at a later time that this session would otherwise have to stay open for.
- The human wants work done after they close this session.

Do not use it for work you can do now.

## Write the instruction so it stands alone

The instruction comes back hours later, maybe after a resume, maybe with the human away. Write it so that someone who never saw this conversation can carry it out:

- Say what to do and on what: the file, repository, branch, command, page or figure to check.
- Say where: absolute paths, full names.
- Say what "done" is.
- Say what to report in the reply.
- Write absolute dates and times with their offset, such as 2026-11-24T14:00:00+08:00. Never "tomorrow", "later" or "this afternoon".
- Never "as discussed", "the file above", "that bug" or "the usual". Name the thing.

## Give the time

1. Read the clock first: run `date +%Y-%m-%dT%H:%M:%S%z`.
2. Pass `--at` one of two forms:
   - an ISO 8601 date-time with an offset, such as `2026-11-24T14:00:00+08:00`; use the offset `date` printed;
   - an ISO 8601 duration from now, such as `PT2M`, `PT90M` or `PT3H`.
3. A time of day the human names, such as "at 14:00", is in their local zone, today. If that time has already passed today, do not guess: ask the human which day they mean.

## Register the work

Run the one script that ships beside this skill. Put the instruction on standard input through a here-document whose delimiter is quoted, so the shell expands nothing in it:

```sh
sh "${CLAUDE_SKILL_DIR}/register.sh" --at 2026-11-24T14:00:00+08:00 <<'INSTRUCTION'
In /home/me/work/site, run `npm run build` and check that it exits 0.
Done means the build passed or you know why it failed.
Report the exit code and the first error line, if any.
INSTRUCTION
```

- Register each piece of work once, in its own run of the script. Never register the same work twice.
- Do not reach soma any other way. The script is the only way in.

## Read the answer

The script prints one line and exits.

- Exit 0, `accepted as <id>; at <time> ...`: tell the human the id and the time, and that this session may be closed now. Do not offer to change or cancel it: there is no way to from here.
- Exit 1, `refused: <reason>`: the work is not registered. Tell the human the reason. Exit 1 with a line saying nothing was registered: tell the human that line.
- Exit 2, a usage line: the command was wrong. Fix it and run it again.
- Exit 3, `not confirmed: ...`: tell the human that soma has not answered, that the request is kept, and that soma takes it when it runs unless its time has passed by then. Pass on what the line says about withdrawing it. Do not register it again.
