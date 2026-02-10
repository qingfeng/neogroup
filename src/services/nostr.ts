import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { bech32 } from 'bech32'

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

// --- Key Generation & Encryption ---

export async function generateNostrKeypair(masterKeyHex: string): Promise<{
  pubkey: string
  privEncrypted: string
  iv: string
}> {
  const privateKey = schnorr.utils.randomPrivateKey()
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey))

  const { encrypted, iv } = await encryptPrivkey(bytesToHex(privateKey), masterKeyHex)

  return { pubkey, privEncrypted: encrypted, iv }
}

async function importMasterKey(masterKeyHex: string): Promise<CryptoKey> {
  const keyBytes = hexToBytes(masterKeyHex)
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encryptPrivkey(privkeyHex: string, masterKeyHex: string): Promise<{ encrypted: string; iv: string }> {
  const key = await importMasterKey(masterKeyHex)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(privkeyHex)

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)

  return {
    encrypted: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
  }
}

export async function decryptNostrPrivkey(encrypted: string, iv: string, masterKeyHex: string): Promise<string> {
  const key = await importMasterKey(masterKeyHex)
  const ciphertextBuf = base64ToBuffer(encrypted)
  const ivBuf = new Uint8Array(base64ToBuffer(iv))

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ciphertextBuf)

  return new TextDecoder().decode(plaintext)
}

// --- Event Building & Signing ---

export async function buildSignedEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  kind: number
  content: string
  tags: string[][]
  createdAt?: number
}): Promise<NostrEvent> {
  const privkeyHex = await decryptNostrPrivkey(params.privEncrypted, params.iv, params.masterKey)
  const privateKey = hexToBytes(privkeyHex)
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey))

  const event = {
    pubkey,
    created_at: params.createdAt || Math.floor(Date.now() / 1000),
    kind: params.kind,
    tags: params.tags,
    content: params.content,
  }

  // Compute event ID: sha256 of [0, pubkey, created_at, kind, tags, content]
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)))

  // Schnorr sign
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privateKey))

  return { id, ...event, sig }
}

// --- NIP-19 Encoding ---

export function pubkeyToNpub(hex: string): string {
  const bytes = hexToBytes(hex)
  const words = bech32.toWords(Array.from(bytes))
  return bech32.encode('npub', words, 90)
}

export function privkeyToNsec(hex: string): string {
  const bytes = hexToBytes(hex)
  const words = bech32.toWords(Array.from(bytes))
  return bech32.encode('nsec', words, 90)
}

// --- Helpers ---

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
