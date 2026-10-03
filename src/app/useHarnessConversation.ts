import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { HarnessConversations } from '../harness'
import { projectSession } from '../chat/sessionProjection'

export function useHarnessConversation() {
  const [service] = useState(() => new HarnessConversations())
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot)
  useEffect(() => { service.start(); return () => service.stop() }, [service])
  const messages = useMemo(() => projectSession(snapshot.events), [snapshot.events])
  return { service, messages, error: snapshot.error, activeTurnId: snapshot.activeTurnId }
}
