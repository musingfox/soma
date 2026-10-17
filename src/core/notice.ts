import type { NoticeKind } from "../ports/human.ts";

/** Entry kind of a notice to the human; HumanPort turns each one into a notice event. */
export const NOTICE = "notice";

export const noticeEntry = (kind: NoticeKind, content: string) => ({ kind: NOTICE, data: { kind, content } });
