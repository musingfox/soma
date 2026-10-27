import { spawn } from "@lydell/node-pty";
import type { SpawnPty } from "./agent-port.ts";

/** node-pty's spawn, kept out of agent-port.ts so its tests never load the native module. */
export const spawnPty: SpawnPty = (file, args, options) => spawn(file, args, options);
