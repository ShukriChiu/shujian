import { useSyncExternalStore } from 'react'
import { getCredentials, onCredentialsChange, type Credentials } from './credentials'

const SSR_FALLBACK: Credentials = { apiKey: '', sessionToken: '' }
const ssrSnapshot = () => SSR_FALLBACK

export function useCredentials(): Credentials {
  return useSyncExternalStore(onCredentialsChange, getCredentials, ssrSnapshot)
}
