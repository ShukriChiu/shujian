import { useSyncExternalStore } from 'react'
import { listVaults, onVaultsChange, type Vault } from './vaults'

const SSR_FALLBACK: Vault[] = []
const ssrSnapshot = () => SSR_FALLBACK

/**
 * Subscribes to the vault cache and triggers a background fetch on first
 * read (see `lib/vaults::listVaults`). Returns the in-memory snapshot —
 * `envs` is hydrated lazily; call `loadVault(id)` before reading values.
 */
export function useVaults(): Vault[] {
  return useSyncExternalStore(onVaultsChange, listVaults, ssrSnapshot)
}
