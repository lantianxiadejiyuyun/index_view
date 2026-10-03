import { randomBytes } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { sql } from './db.js'
import { getLingxiBinding, type LingxiBinding } from './lingxi.js'
import { LingxiError, lingxiAddresses, normalizeLingxiBaseUrl } from './lingxi-transport.js'

const ENDPOINT = '/api/lingxi/ws'
type Ticket = { userId: number; sessionId: string; bindingVersion: number; expiresAt: number }
const tickets = new Map<string, Ticket>()
function current(ticket: Ticket): boolean {
  return Boolean(sql.get('SELECT id FROM auth_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?', ticket.sessionId, ticket.userId, Date.now())
    && sql.get('SELECT user_id FROM lingxi_bindings WHERE user_id=? AND updated_at=?', ticket.userId, ticket.bindingVersion))
}
/** Tickets are short-lived, single use, and sent only in the first frame, never a URL. */
export function createLingxiWebSocketTicket(userId: number, sessionId: string) {
  for (const [value, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(value)
  if (tickets.size >= 256 || [...tickets.values()].filter(ticket => ticket.userId === userId).length >= 4) throw new LingxiError('实时连接请求过多，请稍后重试', 429)
  const binding = getLingxiBinding(userId), ticket = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 60_000
  tickets.set(ticket, { userId, sessionId, bindingVersion: binding.updated_at, expiresAt })
  return { ticket, expires_at: expiresAt, path: ENDPOINT, protocol: 'lingxi.v1' }
}
type Session = {
  socket: WebSocket; upstream: WebSocket | null; ticket: Ticket | null; binding: LingxiBinding | null
  authTimer: NodeJS.Timeout | null; readyTimer: NodeJS.Timeout | null; closed: boolean; ready: boolean; busy: boolean
  lastSeen: number; windowAt: number; frames: number; controller: AbortController
}
type Options = { authTimeoutMs?: number; readyTimeoutMs?: number; sweepMs?: number; idleMs?: number }

/** Other upgrade listeners must ignore paths they do not own. Returns a shutdown function. */
export function attachLingxiWebSocket(server: Pick<EventEmitter, 'on' | 'off'>, options: Options = {}): () => Promise<void> {
  const sessions = new Set<Session>(), wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false })
  let stopped = false, closing: Promise<void> | null = null
  function close(session: Session, code = 1000, reason = 'closed') {
    if (session.closed) return
    session.closed = true; session.controller.abort(); sessions.delete(session)
    if (session.authTimer) clearTimeout(session.authTimer)
    if (session.readyTimer) clearTimeout(session.readyTimer)
    for (const socket of [session.socket, session.upstream]) {
      if (!socket || socket.readyState === WebSocket.CLOSED) continue
      if (socket.readyState === WebSocket.CONNECTING) { socket.terminate(); continue }
      socket.close(code, reason)
      const timer = setTimeout(() => socket.terminate(), 1000); timer.unref()
      socket.once('close', () => clearTimeout(timer))
    }
  }
  function send(session: Session, socket: WebSocket, value: unknown): boolean {
    if (session.closed || socket.readyState !== WebSocket.OPEN) return false
    if (socket.bufferedAmount > 256 * 1024) { close(session, 1013, 'slow_consumer'); return false }
    socket.send(JSON.stringify(value), error => { if (error) close(session, 1011, 'send_failed') })
    return true
  }
  async function connect(session: Session) {
    const ticket = session.ticket!
    const binding = getLingxiBinding(ticket.userId); session.binding = binding
    const allowPrivate = process.env.LINGXI_ALLOW_PRIVATE_NETWORK === 'true'
    const url = new URL(normalizeLingxiBaseUrl(binding.base_url, allowPrivate) + '/api/v1/ws')
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const addresses = await lingxiAddresses(hostname, allowPrivate, AbortSignal.any([session.controller.signal, AbortSignal.timeout(15_000)]))
    if (session.closed || !current(ticket)) { close(session, 1008, 'authorization_revoked'); return }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const upstream = new WebSocket(url, {
      followRedirects: false, handshakeTimeout: 15_000, maxPayload: 1024 * 1024, perMessageDeflate: false,
      lookup: (_host, opts, callback) => opts.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family),
    })
    session.upstream = upstream
    session.readyTimer = setTimeout(() => close(session, 1011, 'upstream_ready_timeout'), options.readyTimeoutMs ?? 20_000); session.readyTimer.unref()
    upstream.on('open', () => {
      if (!current(ticket)) { close(session, 1008, 'authorization_revoked'); return }
      send(session, upstream, { type: 'auth', token: binding.api_token })
    })
    upstream.on('message', (raw, binary) => {
      if (session.closed) return
      if (!current(ticket)) { close(session, 1008, 'authorization_revoked'); return }
      if (binary) { close(session, 1002, 'text_frames_required'); return }
      try {
        const frame = JSON.parse(raw.toString())
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !['ready', 'start', 'ack', 'delta', 'tool', 'notice', 'title', 'error', 'done', 'pong'].includes(frame.type)) throw new Error()
        if (frame.type === 'ready') {
          if (Number(frame.data?.user_id) !== binding.user.id) { close(session, 1008, 'upstream_identity_changed'); return }
          session.ready = true; if (session.readyTimer) clearTimeout(session.readyTimer)
        }
        if (frame.type === 'done' || (frame.type === 'error' && frame.seq === 0)) session.busy = false
        // Neither the binding Token nor upstream auth frames are browser-visible.
        send(session, session.socket, JSON.parse(JSON.stringify(frame).replaceAll(binding.api_token, '[已隐藏]')))
      } catch { close(session, 1002, 'invalid_upstream_message') }
    })
    upstream.on('error', () => close(session, 1011, 'upstream_connection_failed'))
    upstream.on('close', () => close(session, 1011, 'upstream_closed'))
  }
  wss.on('connection', socket => {
    const session: Session = { socket, upstream: null, ticket: null, binding: null, authTimer: null, readyTimer: null, closed: false, ready: false, busy: false,
      lastSeen: Date.now(), windowAt: Date.now(), frames: 0, controller: new AbortController() }
    sessions.add(session)
    session.authTimer = setTimeout(() => close(session, 1008, 'authentication_timeout'), options.authTimeoutMs ?? 10_000); session.authTimer.unref()
    socket.on('error', () => close(session, 1011, 'client_error'))
    socket.on('close', () => close(session))
    socket.on('pong', () => { session.lastSeen = Date.now() })
    socket.on('message', (raw, binary) => {
      if (session.closed) return
      if (Date.now() - session.windowAt >= 1000) { session.windowAt = Date.now(); session.frames = 0 }
      if (++session.frames > 30 || binary) { close(session, 1008, 'invalid_frame_rate'); return }
      let frame: Record<string, unknown>
      try { frame = JSON.parse(raw.toString()); if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error() }
      catch { close(session, 1002, 'invalid_message'); return }
      session.lastSeen = Date.now()
      if (!session.ticket) {
        if (frame.type !== 'auth' || typeof frame.ticket !== 'string') { close(session, 1008, 'authentication_required'); return }
        const ticket = tickets.get(frame.ticket); tickets.delete(frame.ticket)
        if (!ticket || ticket.expiresAt <= Date.now() || !current(ticket)) { close(session, 1008, 'authentication_failed'); return }
        if ([...sessions].filter(item => item.ticket?.userId === ticket.userId).length >= 4) { close(session, 1013, 'connection_limit'); return }
        session.ticket = ticket
        if (session.authTimer) clearTimeout(session.authTimer)
        void connect(session).catch(() => close(session, 1011, 'upstream_connection_failed'))
        return
      }
      if (!current(session.ticket)) { close(session, 1008, 'authorization_revoked'); return }
      if (frame.type === 'ping') { send(session, socket, { type: 'pong', request_id: typeof frame.request_id === 'string' ? frame.request_id.slice(0, 100) : undefined }); return }
      if (frame.type !== 'chat.send' || !session.ready || !session.upstream) { close(session, 1002, 'unexpected_message'); return }
      if (session.busy) { send(session, socket, { type: 'error', data: '当前对话正在回复，请等待完成' }); return }
      if (!Number.isSafeInteger(frame.conversation_id) || Number(frame.conversation_id) <= 0 || typeof frame.message !== 'string' || !frame.message.trim() || frame.message.length > 32000 ||
          (frame.request_id !== undefined && (typeof frame.request_id !== 'string' || frame.request_id.length > 100))) { close(session, 1008, 'invalid_chat_request'); return }
      session.busy = true
      send(session, session.upstream, { type: 'chat.send', conversation_id: frame.conversation_id, message: frame.message, request_id: frame.request_id })
    })
  })
  function reject(socket: Duplex, status: number) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) }
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if ((request.url ?? '').split('?')[0] !== ENDPOINT) return
    if (request.url !== ENDPOINT || request.method !== 'GET') { reject(socket, 400); return }
    if (stopped || sessions.size >= 64) { reject(socket, 503); return }
    if (request.headers.origin) {
      try { if (new URL(request.headers.origin).host !== request.headers.host) { reject(socket, 403); return } }
      catch { reject(socket, 403); return }
    }
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request))
  }
  server.on('upgrade', upgrade)
  const sweep = setInterval(() => {
    for (const session of sessions) {
      if (session.ticket && !current(session.ticket)) { close(session, 1008, 'authorization_revoked'); continue }
      if (Date.now() - session.lastSeen > (options.idleMs ?? 90_000)) { close(session, 1001, 'heartbeat_timeout'); continue }
      if (session.socket.readyState === WebSocket.OPEN) session.socket.ping()
    }
    for (const [value, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(value)
  }, options.sweepMs ?? 25_000); sweep.unref()
  return () => {
    if (closing) return closing
    stopped = true; clearInterval(sweep); server.off('upgrade', upgrade)
    for (const session of [...sessions]) close(session, 1001, 'server_shutdown')
    closing = new Promise<void>(resolve => { wss.close(() => resolve()); const force = setTimeout(() => { for (const socket of wss.clients) socket.terminate(); resolve() }, 1200); force.unref() })
    return closing
  }
}
