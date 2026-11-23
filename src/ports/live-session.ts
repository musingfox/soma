/**
 * A claude process alive now that has the Claude Code session `sessionId` open, with the directory it says it runs in;
 * undefined when there is none. Throws when it cannot look, which is doubt, never "none": soma resumes a handed-off
 * session only when no other process has it open, so two claudes never write one transcript.
 */
export type LiveSession = (sessionId: string) => Promise<{ readonly pid: number; readonly cwd?: string } | undefined>;
