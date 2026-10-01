import type { IncomingMessage } from 'node:http'
import type { EventEmitter } from 'node:events'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  authenticateSubscriptionRelay, claimSubscriptionRelayJob, clearSubscriptionRelaySocket,
  onSubscriptionRelayWork, subscriptionRelayIdentityValid, subscriptionRelayLeaseIsCurrent, touchSubscriptionRelaySocket,
  type SubscriptionRelayIdentity, type SubscriptionRelayJob,
} from './subscription-relay.js'

const ENDPOINT = '/api/agent/subscriptions/ws'
const HEARTBEAT_MS = 25_000
type Options = {
  authTimeoutMs?: number; ackTimeoutMs?: number; idleTimeoutMs?: number
  sweepMs?: number; maxUnauthenticated?: number
}
type Session = {
  socket: WebSocket; owner: object; identity: SubscriptionRelayIdentity | null
  lastSeenAt: number; touchedAt: number; closed: boolean; dispatchPending: boolean
  authTimer: NodeJS.Timeout | null; ackTimer: NodeJS.Timeout | null; terminateTimer: NodeJS.Timeout | null
  currentJob: SubscriptionRelayJob | null; delivered: Map<string, number>
  frameWindow: number; frameCount: number
}

/** Attach to the existing HTTP listener; TLS is normally terminated by the
 * deployment reverse proxy. All credentials travel in the first bounded frame.
 * Options permit short deadlines in isolated socket tests, not HTTP settings. */
export function attachSubscriptionRelayWebSocket(server: Pick<EventEmitter, 'on' | 'off'>, options: Options = {}): () => Promise<void> {
  const authTimeout = options.authTimeoutMs ?? 5_000
  const ackTimeout = options.ackTimeoutMs ?? 10_000
  const idleTimeout = options.idleTimeoutMs ?? 70_000
  const maxUnauthenticated = options.maxUnauthenticated ?? 32
  const sessions = new Set<Session>()
  const active = new Map<number, Session>()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024, perMessageDeflate: false })
  let stopped = false
  let closing: Promise<void> | null = null

  function cleanup(session: Session): void {
    session.closed = true
    if (session.authTimer) clearTimeout(session.authTimer)
    if (session.ackTimer) clearTimeout(session.ackTimer)
    if (session.terminateTimer) clearTimeout(session.terminateTimer)
    session.authTimer = session.ackTimer = session.terminateTimer = null
    sessions.delete(session)
    if (session.identity) {
      if (active.get(session.identity.id) === session) active.delete(session.identity.id)
      clearSubscriptionRelaySocket(session.identity.id, session.owner)
    }
  }
  function close(session: Session, code: number, reason: string): void {
    if (session.closed) return
    cleanup(session)
    session.socket.close(code, reason)
    // A peer that never completes the close handshake cannot keep an
    // unauthenticated socket or revoked connection around indefinitely.
    session.terminateTimer = setTimeout(() => session.socket.terminate(), 1_000)
    session.terminateTimer.unref()
  }
  function send(session: Session, value: object): boolean {
    if (stopped || session.closed || session.socket.readyState !== WebSocket.OPEN) return false
    if (session.socket.bufferedAmount > 64 * 1024) { close(session, 1013, 'slow_consumer'); return false }
    session.socket.send(JSON.stringify(value), (error) => { if (error) close(session, 1011, 'send_failed') })
    return true
  }
  function clearCurrent(session: Session): void {
    session.currentJob = null
    if (session.ackTimer) clearTimeout(session.ackTimer)
    session.ackTimer = null
  }
  function dispatch(session: Session): void {
    if (stopped || session.closed || !session.identity) return
    if (!subscriptionRelayIdentityValid(session.identity)) { close(session, 1008, 'authorization_revoked'); return }
    const now = Date.now()
    for (const [id, deadline] of session.delivered) if (deadline <= now) session.delivered.delete(id)
    if (session.currentJob && session.currentJob.expires_at > now && subscriptionRelayLeaseIsCurrent(session.identity, session.currentJob.id)) return
    clearCurrent(session)
    const job = claimSubscriptionRelayJob(session.identity, true)
    if (!job || session.delivered.has(job.id)) return
    session.currentJob = job
    session.delivered.set(job.id, job.expires_at)
    if (!send(session, { type: 'job', job, server_time: Date.now() })) return
    session.ackTimer = setTimeout(() => close(session, 1011, 'task_ack_timeout'), Math.min(ackTimeout, Math.max(1, job.expires_at - now)))
    session.ackTimer.unref()
  }
  function scheduleDispatch(session: Session): void {
    if (stopped || session.closed || session.dispatchPending) return
    session.dispatchPending = true
    queueMicrotask(() => {
      session.dispatchPending = false
      if (stopped || session.closed) return
      try { dispatch(session) }
      catch { close(session, 1011, 'task_dispatch_failed') }
    })
  }
  const unsubscribe = onSubscriptionRelayWork((event) => {
    const session = active.get(event.agentId)
    if (!session || stopped) return
    if (event.completedJobId === session.currentJob?.id) clearCurrent(session)
    scheduleDispatch(session)
  })

  wss.on('connection', (socket) => {
    const now = Date.now()
    const session: Session = {
      socket, owner: {}, identity: null, lastSeenAt: now, touchedAt: 0, closed: false, dispatchPending: false,
      authTimer: null, ackTimer: null, terminateTimer: null, currentJob: null, delivered: new Map(),
      frameWindow: now, frameCount: 0,
    }
    sessions.add(session)
    session.authTimer = setTimeout(() => close(session, 1008, 'authentication_timeout'), authTimeout)
    session.authTimer.unref()
    socket.on('error', () => { cleanup(session) })
    socket.on('close', () => { cleanup(session) })
    socket.on('message', (raw, isBinary) => {
      if (stopped || session.closed) return
      const time = Date.now()
      if (time - session.frameWindow >= 1_000) { session.frameWindow = time; session.frameCount = 0 }
      if (++session.frameCount > 100) { close(session, 1008, 'message_rate_exceeded'); return }
      if (isBinary) { close(session, 1002, 'text_frames_required'); return }
      let frame: Record<string, unknown>
      try {
        const value: unknown = JSON.parse(raw.toString())
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
        frame = value as Record<string, unknown>
      } catch { close(session, 1002, 'invalid_message'); return }
      try {
        if (!session.identity) {
          if (frame.type !== 'auth' || frame.version !== 1 || typeof frame.key !== 'string') {
            close(session, 1008, 'authentication_required'); return
          }
          const identity = authenticateSubscriptionRelay(frame, frame.key)
          const previous = active.get(identity.id)
          if (previous) close(previous, 1012, 'connection_replaced')
          session.identity = identity
          active.set(identity.id, session)
          if (!touchSubscriptionRelaySocket(identity, session.owner, time)) { close(session, 1008, 'authorization_revoked'); return }
          session.touchedAt = time
          session.lastSeenAt = time
          if (session.authTimer) clearTimeout(session.authTimer)
          session.authTimer = null
          send(session, { type: 'ready', version: 1, server_time: time, heartbeat_ms: HEARTBEAT_MS })
          scheduleDispatch(session)
          return
        }
        if (!subscriptionRelayIdentityValid(session.identity)) { close(session, 1008, 'authorization_revoked'); return }
        if (frame.type === 'ping') {
          send(session, { type: 'pong', server_time: time })
        } else if (frame.type === 'ack' && typeof frame.job_id === 'string' && session.delivered.has(frame.job_id)) {
          if (frame.job_id === session.currentJob?.id && session.ackTimer) {
            clearTimeout(session.ackTimer)
            session.ackTimer = null
          }
        } else { close(session, 1002, 'unexpected_message'); return }
        session.lastSeenAt = time
        if (time - session.touchedAt >= 1_000) {
          if (!touchSubscriptionRelaySocket(session.identity, session.owner, time)) { close(session, 1008, 'authorization_revoked'); return }
          session.touchedAt = time
        }
      } catch { close(session, 1008, 'authentication_failed') }
    })
  })

  function reject(socket: Duplex, status: number): void {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (stopped) { reject(socket, 503); return }
    // Exact URL matching rejects query-string credentials and prevents the
    // WebSocket adapter from inheriting cookies or browser origin authority.
    if (request.url !== ENDPOINT || request.method !== 'GET') { reject(socket, 404); return }
    if (request.headers.origin) { reject(socket, 403); return }
    const unauthenticated = [...sessions].filter((session) => !session.identity).length
    if (unauthenticated >= maxUnauthenticated) { reject(socket, 429); return }
    wss.handleUpgrade(request, socket, head, (client) => { wss.emit('connection', client, request) })
  }
  server.on('upgrade', upgrade)
  const sweep = setInterval(() => {
    if (stopped) return
    for (const session of sessions) {
      if (!session.identity) continue
      if (Date.now() - session.lastSeenAt >= idleTimeout) { close(session, 1001, 'heartbeat_timeout'); continue }
      scheduleDispatch(session)
    }
  }, options.sweepMs ?? 5_000)
  sweep.unref()

  return () => {
    if (closing) return closing
    stopped = true
    clearInterval(sweep)
    unsubscribe()
    server.off('upgrade', upgrade)
    for (const session of [...sessions]) cleanup(session)
    closing = Promise.all([...wss.clients].map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return }
      const force = setTimeout(() => { socket.terminate(); resolve() }, 250)
      force.unref()
      socket.once('close', () => { clearTimeout(force); resolve() })
      socket.close(1001, 'server_shutdown')
    }))).then(() => { wss.close() })
    return closing
  }
}
