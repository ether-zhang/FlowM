import { useEffect, useState, useSyncExternalStore } from 'react'
import { harnessClient, HarnessConnections } from '../harness'

/** React subscribes to the harness-owned connection state; it does not resolve models. */
export function useHarnessConnection() {
  const [service] = useState(() => new HarnessConnections(harnessClient, localStorage))
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot)
  useEffect(() => { service.start(); return () => service.stop() }, [service])
  return { ...snapshot, refresh: service.refresh, selectModel: service.selectModel, save: service.save,
    login: service.login, logout: service.logout, connect: service.connect, cancelLogin: service.cancelLogin, forgetGatewayToken: service.forgetGatewayToken,
    getConnection: service.getConnection }
}
