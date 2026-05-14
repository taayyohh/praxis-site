// lib/config.js — Centralized configuration for Praxis server
// All values readable from env vars with sensible defaults.
// Import this instead of hardcoding magic numbers in server.js.

// --- Tenant / domain resolution ---
export const TENANT_CACHE_MAX = parseInt(process.env.TENANT_CACHE_MAX || '5000')
export const DOMAIN_INDEX_INTERVAL = parseInt(process.env.DOMAIN_INDEX_INTERVAL || String(5 * 60 * 1000))

// --- Static file cache ---
export const STATIC_CACHE_MAX = parseInt(process.env.STATIC_CACHE_MAX || String(30 * 1024 * 1024))
export const STATIC_FILE_MAX = parseInt(process.env.STATIC_FILE_MAX || String(1 * 1024 * 1024))

// --- Stat result cache ---
export const STAT_CACHE_MAX = parseInt(process.env.STAT_CACHE_MAX || '5000')

// --- IPFS cache ---
export const IPFS_CACHE_MAX = parseInt(process.env.IPFS_CACHE_MAX || String(50 * 1024 * 1024))
export const IPFS_PROXY_MAX = parseInt(process.env.IPFS_PROXY_MAX || '50')

// --- Upload queue ---
export const UPLOAD_WORKERS = parseInt(process.env.UPLOAD_WORKERS || '3')
export const UPLOAD_QUEUE_MAX = parseInt(process.env.UPLOAD_QUEUE_MAX || '1000')

// --- Ponder cache ---
export const PONDER_CACHE_MAX = parseInt(process.env.PONDER_CACHE_MAX || '2000')

// --- Resolve cache ---
export const RESOLVE_CACHE_MAX = parseInt(process.env.RESOLVE_CACHE_MAX || '10000')

// --- Site JSON cache ---
export const SITE_JSON_CACHE_MAX = parseInt(process.env.SITE_JSON_CACHE_MAX || '5000')

// --- Sessions ---
export const SESSIONS_MAX = parseInt(process.env.SESSIONS_MAX || '10000')

// --- Rate limiting ---
export const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '50000')

// --- Search index ---
export const SEARCH_MAX = parseInt(process.env.SEARCH_MAX || '50000')
export const SEARCH_REBUILD_INTERVAL = parseInt(process.env.SEARCH_REBUILD_INTERVAL || String(5 * 60 * 1000))
