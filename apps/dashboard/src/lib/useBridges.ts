import { useSyncExternalStore } from 'react'
import {
  getActiveBridge,
  listBridges,
  onBridgesChange,
  type Bridge,
} from './bridges'

const SSR_BRIDGE: Bridge = { id: 'local', name: 'local', endpoint: '/cursor', apiKey: '', sessionToken: '' }
const ssrActive = () => SSR_BRIDGE
const ssrList = () => [SSR_BRIDGE]

export function useActiveBridge(): Bridge {
  return useSyncExternalStore(onBridgesChange, getActiveBridge, ssrActive)
}

export function useBridges(): Bridge[] {
  return useSyncExternalStore(onBridgesChange, listBridges, ssrList)
}
