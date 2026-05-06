import { useSyncExternalStore } from 'react'
import { listVaults, onVaultsChange, type Vault } from './vaults'

const SSR_FALLBACK: Vault[] = []
const ssrSnapshot = () => SSR_FALLBACK

// Cache the array reference so useSyncExternalStore's referential equality
// check doesn't fire a re-render on every read. listVaults() already returns
// the cached state's array, so we can pass it through directly.
export function useVaults(): Vault[] {
  return useSyncExternalStore(onVaultsChange, listVaults, ssrSnapshot)
}
