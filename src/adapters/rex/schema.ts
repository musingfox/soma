// Shapes of rex API revision 7, as its server describes them in GET /api/help and GET /llms.txt (checked 2026-10-27
// against rex 0.0.1792787366-g623b2d). Each object passes unknown fields through: the server adds fields in newer
// revisions and says to ignore the ones a client does not know.
import { z } from "zod";

export const API_REVISION = 7;
export const CONTROL_PROTOCOL = "rex.control.v1";
export const TERMINAL = "com.superlogical.terminal";
export const SHELL_FLAVOR = `${TERMINAL}.shell`;

export const WelcomeSchema = z
	.object({ type: z.literal("welcome"), protocol: z.literal(CONTROL_PROTOCOL), api_revision: z.number().optional() })
	.passthrough();

export const RexErrorSchema = z.object({ code: z.string(), message: z.string(), status: z.number() }).passthrough();

export const ResponseSchema = z
	.object({
		type: z.literal("response"),
		id: z.string(),
		seq: z.number(),
		payload: z.unknown().optional(),
		error: RexErrorSchema.nullish(),
	})
	.passthrough();

const NamedSchema = z.object({ type: z.string(), payload: z.unknown().optional() }).passthrough();

export const EventSchema = z.object({ type: z.literal("event"), seq: z.number(), payload: NamedSchema }).passthrough();

export const SessionEventSchema = z.object({ session_id: z.string(), event: NamedSchema }).passthrough();
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const BlockEventSchema = z
	.object({ block_id: z.string(), creator_name: z.string().optional(), name: z.string(), payload: z.unknown() })
	.passthrough();

/** One OSC 7501 record; the root record is the one without `id`. */
export const StatusRecordSchema = z
	.object({
		id: z.string().optional(),
		state: z.string(),
		kind: z.string().optional(),
		msg: z.string().optional(),
		app: z.string().optional(),
		updated_at: z.string(),
	})
	.passthrough();
export type StatusRecord = z.infer<typeof StatusRecordSchema>;

export const ProgramStatusResultSchema = z.object({ records: z.array(StatusRecordSchema) }).passthrough();

/** `id` is always present here, as an empty string for the root record. */
export const ProgramStatusChangedSchema = z
	.object({ id: z.string(), record: StatusRecordSchema, reason: z.string() })
	.passthrough();

export const ProcessInfoSchema = z
	.object({ pid: z.number(), name: z.string(), argv0: z.string().optional(), cwd: z.string().optional() })
	.passthrough();

export const ProcessResultSchema = z
	.object({ foreground: ProcessInfoSchema.nullish(), child: ProcessInfoSchema.nullish() })
	.passthrough();

const ViewBlockSchema = z
	.object({ block_id: z.string().nullable(), label: z.string().optional(), creator_name: z.string().optional() })
	.passthrough();

const LayerSchema = z.object({ kind: z.string(), blocks: z.array(ViewBlockSchema).nullable() }).passthrough();

export const WindowSchema = z
	.object({ window_id: z.string().nullable(), label: z.string().optional(), layers: z.array(LayerSchema).nullable() })
	.passthrough();
export type RexWindow = z.infer<typeof WindowSchema>;

export const ViewSchema = z
	.object({ revision: z.number(), session_id: z.string().nullable(), windows: z.array(WindowSchema).nullish() })
	.passthrough();

export const AttachResultSchema = z.object({ client_id: z.string(), view: ViewSchema }).passthrough();

export const NewWindowResultSchema = z
	.object({ window_id: z.string().nullable(), block_ids: z.array(z.string().nullable()).nullable() })
	.passthrough();

export const BlockClosedResultSchema = z.object({ block_id: z.string() }).passthrough();

export const WriteResultSchema = z.object({ bytes_written: z.number() }).passthrough();

export const EmptyResultSchema = z.object({}).passthrough();
