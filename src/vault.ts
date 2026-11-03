import { obsidianVault } from "./adapters/obsidian/vault.ts";
import type { VaultConfig } from "./config.ts";
import { type VaultAccess, vaultExtension } from "./core/extensions/vault/index.ts";

/** The vault tools when the config names a vault; none otherwise. */
export function vaultExtensions(vault: VaultConfig | undefined, open: (name: string) => VaultAccess = obsidianVault) {
	return vault ? [vaultExtension(open(vault.name), vault.deny)] : [];
}
