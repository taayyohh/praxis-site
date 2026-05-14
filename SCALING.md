# Praxis Scaling Playbook

> Trigger-based roadmap from current state to 1M+ users.
> Each phase is a backing-store swap behind existing interfaces — not an app rewrite.

## Current State

- Single Hetzner VPS (4 CPU, 8GB RAM, 150GB disk, ~$4/mo)
- **Phase 0 + Phase 1 complete** — solid to ~50K users
- 4 interface boundaries in `lib/`: index-store, search-store, storage, template-engine
- 3,800+ tests, 10 contracts, 20 languages, 18 currencies

## Architecture

```
                    ┌─────────────┐
                    │   Traefik   │  (TLS, routing, load balancing)
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
        │ Multi-    │ │ Ponder│ │Orchestrator│
        │ Tenant    │ │Gateway│ │  API/Scaler│
        │ Server    │ └───┬───┘ └─────┬─────┘
        └─────┬─────┘     │           │
              │      ┌────┴────┐ ┌────┴────┐
              │      │ Ponder  │ │ State   │
              │      │ Indexer │ │ SQLite  │
              │      └────┬────┘ └─────────┘
              │           │
         ┌────┴────┐ ┌───┴───┐
         │  IPFS   │ │Optimism│
         │Write/Read│ │  L2   │
         └─────────┘ └───────┘
```

## What's Already Built

### Phase 0 — Interface Boundaries
| File | Purpose | Current Backend | Future Backend |
|------|---------|----------------|----------------|
| `lib/index-store.js` | Domain/wallet resolution | SQLite (orchestrator DB) | Redis |
| `lib/search-store.js` | Network search | SQLite FTS5 (trigram) | Meilisearch |
| `lib/storage.js` | Media upload/serve | Kubo IPFS | IPFS + cache layer |
| `lib/template-engine.js` | Page rendering | Dynamic from cached shells | (done) |
| `lib/config.js` | Tunable constants | Env vars with defaults | (done) |

### Phase 1 — SQLite Backing Stores
- Index store reads from orchestrator SQLite DB with 60s TTL cache
- Search uses FTS5 — no 50K cap, sub-millisecond at 1M+ entries
- Primary-only IPC index building (1 scan instead of N workers)
- Ponder Postgres toggle ready (set `PONDER_DATABASE_URL`)

## Trigger-Based Phases

### Phase 1 Remaining: 10K-50K users ($10-25/mo)

**Triggers**: Memory >4GB OR Ponder queries >200ms p99

| Action | How | Cost |
|--------|-----|------|
| Ponder → Postgres | Set `PONDER_DATABASE_URL` env var, restart | +$8/mo |
| Upgrade VPS | Hetzner CAX21 or add 2nd VPS | +$4-8/mo |
| IPFS cache layer | Update `lib/storage.js` with disk cache | $0 |

### Phase 2: 50K-100K users ($50-150/mo)

**Triggers**: Postgres connections >50 OR search rebuild >30s OR CPU >80%

| Action | How | Cost |
|--------|-----|------|
| Add Redis | Swap `lib/index-store.js` implementation | +$8/mo |
| Meilisearch | Swap `lib/search-store.js` implementation | +$8/mo |
| Separate Ponder VPS | Move indexer + Postgres to own machine | +$8/mo |
| CDN | Cloudflare (free) or BunnyCDN for static assets | +$0-1/mo |
| Horizontal multi-tenant | 2-3 servers behind Traefik | +$8-12/mo |

### Phase 3: 100K-1M users ($200-500/mo)

**Triggers**: Postgres read latency >100ms OR RPC rate limited OR container spin-up >30s

| Action | How | Cost |
|--------|-----|------|
| Postgres read replicas | 1-2 replicas for Ponder reads | +$16/mo |
| Own Optimism RPC | Self-hosted, eliminates 25 req/s limit | +$50/mo |
| Follow table partitioning | `PARTITION BY HASH` (256 partitions) | $0 |
| IPFS Cluster (3 nodes) | Pin replication + write availability | +$12/mo |
| Worker specialization | API vs static vs IPFS workers | $0 |

### Phase 4: 1M+ users ($500-2000/mo)

**Triggers**: Geographic latency OR multi-region compliance needs

| Action | How | Cost |
|--------|-----|------|
| Multi-region (3 regions) | Ashburn + Falkenstein + Helsinki | +$200/mo |
| Event-driven architecture | Redis pub/sub replaces all polling | $0 |
| K3s orchestration | Replace Docker + shell scripts | $0 |
| Sharded Ponder instances | Per-contract indexer shards | +$24/mo |

## Cost Trajectory

| Scale | Users | Monthly Cost | Per-User Cost |
|-------|-------|-------------|---------------|
| Now | 15 | $4 | $0.27 |
| Phase 1 | 10K | $25 | $0.003 |
| Phase 2 | 100K | $150 | $0.002 |
| Phase 3 | 1M | $500 | $0.001 |
| Phase 4 | 1M+ | $2,000 | $0.002 |

## Key Env Vars for Scaling

```bash
# Phase 1: Postgres for Ponder
PONDER_DATABASE_URL=postgres://user:pass@host:5432/praxis

# Phase 1: Tune constants
TENANT_CACHE_MAX=10000
PONDER_CACHE_MAX=5000
RESOLVE_CACHE_MAX=50000
IPFS_PROXY_MAX=100
UPLOAD_WORKERS=10

# Phase 2: Redis
REDIS_URL=redis://host:6379
INDEX_STORE_BACKEND=redis

# Phase 2: Meilisearch
SEARCH_BACKEND=meilisearch
MEILISEARCH_URL=http://host:7700
MEILISEARCH_KEY=your-key

# Phase 2: Search DB path (FTS5)
SEARCH_DB=/data/search.db
```

## IPFS Philosophy

Storage is ALWAYS IPFS — never centralized cloud storage. The `lib/storage.js` interface adds caching layers in front of IPFS:

```
Request → Disk Cache (NVMe) → CDN → IPFS Cluster → Kubo Node
```

CIDs and content addressing are preserved at every tier. Decentralized storage is non-negotiable.

## Monitoring Checklist

When scaling, watch these metrics:
- `pm2 monit` — RSS memory per process
- Ponder GraphQL latency (p50, p99)
- `_hostConnections` size (active concurrent users)
- IPFS proxy queue depth
- Disk usage on /data/artists/
- Deploy duration (should stay <30s after Phase 0)
