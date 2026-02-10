import { useWebSocketImplementation, Relay } from 'nostr-tools/relay'
import WebSocket from 'ws'
import express from 'express'

useWebSocketImplementation(WebSocket)

const RELAYS = (process.env.RELAY_LIST || 'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band').split(',').map(s => s.trim()).filter(Boolean)
const AUTH_TOKEN = process.env.BRIDGE_TOKEN
const PORT = process.env.PORT || 3000

if (!AUTH_TOKEN) {
  console.error('BRIDGE_TOKEN is required')
  process.exit(1)
}

// --- Relay connection pool ---

const relayPool = new Map()

async function connectRelay(url) {
  try {
    console.log(`[Relay] Connecting to ${url}...`)
    const relay = await Relay.connect(url)
    relayPool.set(url, relay)
    console.log(`[Relay] Connected to ${url}`)

    relay.onclose = () => {
      console.log(`[Relay] Disconnected from ${url}, reconnecting in 5s...`)
      relayPool.delete(url)
      setTimeout(() => connectRelay(url), 5000)
    }
  } catch (e) {
    console.error(`[Relay] Failed to connect to ${url}:`, e.message)
    setTimeout(() => connectRelay(url), 5000)
  }
}

// Connect to all relays on startup
for (const url of RELAYS) {
  connectRelay(url)
}

// --- HTTP server ---

const app = express()
app.use(express.json({ limit: '1mb' }))

// Auth middleware
app.use((req, res, next) => {
  // Skip auth for health check
  if (req.path === '/health') return next()

  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// Broadcast endpoint
app.post('/broadcast', async (req, res) => {
  const { events } = req.body
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events must be a non-empty array' })
  }

  console.log(`[Broadcast] Received ${events.length} event(s)`)

  const results = []
  for (const event of events) {
    const relayResults = {}
    for (const [url, relay] of relayPool) {
      try {
        await relay.publish(event)
        relayResults[url] = 'ok'
      } catch (e) {
        relayResults[url] = e.message || 'failed'
      }
    }
    console.log(`[Broadcast] Event ${event.id.slice(0, 8)}... kind=${event.kind} -> ${Object.entries(relayResults).map(([u, s]) => `${new URL(u).host}:${s}`).join(', ')}`)
    results.push({ id: event.id, relays: relayResults })
  }

  res.json({ results })
})

// Health check
app.get('/health', (req, res) => {
  const relays = {}
  for (const url of RELAYS) {
    relays[url] = relayPool.has(url) ? 'connected' : 'disconnected'
  }
  res.json({
    status: 'ok',
    relays,
    connectedCount: relayPool.size,
    totalCount: RELAYS.length,
  })
})

app.listen(PORT, () => {
  console.log(`[Broadcaster] Listening on :${PORT}`)
  console.log(`[Broadcaster] Relays: ${RELAYS.join(', ')}`)
})
