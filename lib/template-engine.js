// Template-at-Serve-Time engine (Phase 0.4)
//
// Pre-loads template shells (layout + index + section HTML) and renders pages
// on the fly by injecting site.json data.  This eliminates the O(N) per-artist
// build loop — only a single set of template shells is built once, and each
// artist's page is rendered at request time from their 5KB site.json.
//
// Usage:
//   import { loadTemplate, renderPage, preloadAllTemplates } from './template-engine.js'
//   const html = renderPage('musician', 'index', siteData, rootDistDir)

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { deriveFullPalette } from '../public/js/contrast.js'
import { MODULE_REGISTRY, LEGACY_TYPE_MAP } from '../modules/index.js'

// templateName -> { layout, index, section, blogIndex, reading, assetManifest, style }
const _templateCache = new Map()

// Max cached templates (7 types + some headroom)
const TEMPLATE_CACHE_MAX = 20

// --- Template variable injection (same as build.js fill()) ---

export function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

// --- Escape helper (same as build.js escapeForHtml) ---

function escapeForHtml(s) {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// --- Template label resolution (mirrors build.js TEMPLATE_LABELS) ---

const TEMPLATE_LABELS = {
  musician:  { audio: 'discography', gallery: 'visuals', demos: 'demos' },
  filmmaker: { film: 'filmography', gallery: 'stills', video: 'reels', demos: 'dailies' },
  visual:    { gallery: 'portfolio', demos: 'sketches' },
  writer:    { writing: 'writing', gallery: 'gallery', demos: 'drafts' },
  performer: { demos: 'rehearsals' },
}

function getTemplateLabel(templateName, moduleType, moduleEntry) {
  if (moduleEntry?.customLabel) return moduleEntry.customLabel
  const overrides = TEMPLATE_LABELS[templateName] || {}
  return overrides[moduleType] || MODULE_REGISTRY[moduleType]?.label || moduleType
}

// --- Module helpers (mirrors build.js loadModules/getEnabledModules) ---

function loadModules(site) {
  if (site.modules) return site.modules
  // Legacy format conversion (same logic as build.js)
  const modules = []
  let order = 1
  const nav = site.nav || []

  const musicAliases = site.music?.aliases || []
  if (musicAliases.length) modules.push({ type: 'music', enabled: nav.includes('music'), order: order++, data: site.music })

  const credits = []
  if (site.theater) {
    for (const c of (site.theater.acting || [])) credits.push({ title: c.production, role: c.role, org: c.company, year: c.year, category: 'theater' })
    for (const c of (site.theater.composing || [])) credits.push({ title: c.description, role: 'composer', category: 'theater' })
  }
  if (site.film) for (const f of site.film) credits.push({ title: f.title, role: f.role, org: f.director ? `dir. ${f.director}` : '', year: f.year, category: 'film' })
  if (site.tv) for (const t of site.tv) credits.push({ title: t.title, role: t.role, org: t.note || '', year: t.year, category: 'tv' })
  if (credits.length) modules.push({ type: 'credits', enabled: true, order: order++, data: credits })

  if (site.engineering?.length || site.portfolio?.length) {
    const techData = { projects: [...(site.engineering || []), ...(site.portfolio || [])] }
    modules.push({ type: 'technology', enabled: nav.includes('engineering') || nav.includes('portfolio'), order: order++, data: techData })
  }

  if (site.gallery?.length) modules.push({ type: 'gallery', enabled: nav.includes('gallery'), order: order++, data: site.gallery })
  if (site.writing?.length) modules.push({ type: 'writing', enabled: nav.includes('writing'), order: order++, data: site.writing })
  if (site.store?.length) modules.push({ type: 'store', enabled: nav.includes('store'), order: order++, data: site.store })

  return modules
}

function getEnabledModules(site) {
  const modules = loadModules(site)
  return modules
    .filter(m => m.enabled !== false && MODULE_REGISTRY[m.type])
    .sort((a, b) => (a.order || 0) - (b.order || 0))
}

// --- Portfolio nav builder (mirrors build.js buildPortfolioNav) ---

function buildPortfolioNav(site) {
  const templateName = site.template || 'default'
  const moduleLinks = getEnabledModules(site).map(m => {
    const mod = MODULE_REGISTRY[m.type]
    const label = getTemplateLabel(templateName, m.type, m)
    const i18nAttr = m.customLabel ? '' : ` data-i18n="module.${m.type}"`
    return `<a href="${mod.route}"${i18nAttr}>${label}</a>`
  }).join(' ')
  return moduleLinks + ' <a href="/blog" data-i18n="nav.blog">blog</a>'
}

// --- Highlights + CV builders (mirrors build.js) ---

function buildHighlights(site) {
  const templateName = site.template || 'default'
  const siteModules = loadModules(site)
  const highlightedTypes = new Set()
  let html = ''

  for (const moduleEntry of getEnabledModules(site)) {
    if (moduleEntry.showOnHomepage === false) continue
    const mod = MODULE_REGISTRY[moduleEntry.type]
    if (!mod?.renderHighlights) continue
    const content = mod.renderHighlights(moduleEntry.data)
    if (!content) continue
    const heading = getTemplateLabel(templateName, moduleEntry.type, moduleEntry)
    html += `<div class="highlights-section"><h3>${heading}</h3>${content}<a href="${mod.route}" class="highlights-view-all">view all \u2192</a></div>`
    highlightedTypes.add(moduleEntry.type)
  }

  return { html, highlightedTypes }
}

function buildCV(site, highlightedTypes) {
  const templateName = site.template || 'default'
  const siteModules = loadModules(site)
  const cvSections = getEnabledModules(site)
    .filter(m => m.showOnHomepage !== false)
    .map(m => m.type)

  let html = '<div class="cv">'
  for (const type of cvSections) {
    if (highlightedTypes.has(type)) continue
    const moduleEntry = siteModules.find(m => m.type === type && m.enabled !== false)
    if (!moduleEntry) continue
    const mod = MODULE_REGISTRY[type]
    if (!mod?.renderCV) continue
    const content = mod.renderCV(moduleEntry.data)
    const cvLabel = getTemplateLabel(templateName, type, moduleEntry)
    if (content) html += `<div class="cv-section"><h3>${cvLabel}</h3>${content}</div>`
  }
  html += '</div>'
  return html
}

// --- Load and cache a template shell ---

export function loadTemplate(templateName, rootDir) {
  if (_templateCache.has(templateName)) return _templateCache.get(templateName)

  // Prefer pre-built template shells (dist/templates/) over source templates (templates/)
  // Pre-built shells are created by BUILD_TEMPLATES_ONLY=1 node build.js
  const shellDir = join(rootDir, 'templates', templateName)
  const sourceDir = join(rootDir, '..', 'templates', templateName)
  const defaultShellDir = join(rootDir, 'templates', 'default')
  const defaultSourceDir = join(rootDir, '..', 'templates', 'default')

  const templateDir = existsSync(shellDir) ? shellDir
    : existsSync(sourceDir) ? sourceDir
    : existsSync(defaultShellDir) ? defaultShellDir
    : defaultSourceDir

  const defaultDir = existsSync(defaultShellDir) ? defaultShellDir : defaultSourceDir

  const layout = readFileSync(join(templateDir, 'layout.html'), 'utf8')
  const index = readFileSync(join(templateDir, 'index.html'), 'utf8')
  const section = readFileSync(join(templateDir, 'section.html'), 'utf8')

  const blogIndex = existsSync(join(templateDir, 'blog-index.html'))
    ? readFileSync(join(templateDir, 'blog-index.html'), 'utf8')
    : readFileSync(join(defaultDir, 'blog-index.html'), 'utf8')

  const reading = existsSync(join(templateDir, 'reading.html'))
    ? readFileSync(join(templateDir, 'reading.html'), 'utf8')
    : readFileSync(join(defaultDir, 'reading.html'), 'utf8')

  // Asset manifest from template shell build (if it exists)
  const manifestPath = join(rootDir, 'templates', templateName, 'asset-manifest.json')
  let assetManifest = {}
  if (existsSync(manifestPath)) {
    try { assetManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch {}
  }

  // Template-specific style
  const stylePath = join(templateDir, 'style.css')
  const hasStyle = templateName !== 'default' && existsSync(stylePath)

  const tpl = { layout, index, section, blogIndex, reading, assetManifest, hasStyle, templateDir }

  // LRU eviction
  if (_templateCache.size >= TEMPLATE_CACHE_MAX) {
    _templateCache.delete(_templateCache.keys().next().value)
  }
  _templateCache.set(templateName, tpl)
  return tpl
}

// --- Pre-load all known template types ---

const KNOWN_TEMPLATES = ['default', 'musician', 'visual', 'writer', 'performer', 'filmmaker', 'organization']

export function preloadAllTemplates(rootDir) {
  for (const name of KNOWN_TEMPLATES) {
    const templateDir = join(rootDir, '..', 'templates', name)
    if (existsSync(templateDir)) {
      loadTemplate(name, rootDir)
    }
  }
}

// --- wrap() equivalent: inject site.json data into layout ---

function wrapHtml(tpl, content, title, canonicalPath, ogImage, site, opts = {}) {
  const portfolioNavHtml = buildPortfolioNav(site)

  const bg = site.theme?.bg || '#0a0a0a'
  const fg = site.theme?.fg || '#c0c0c0'
  const accent = site.theme?.accent || '#ffffff'
  const palette = deriveFullPalette(bg, fg, accent)

  const description = opts.description || site.bio?.slice(0, 160) || ''
  const ogTitle = title ? `${title} — ${site.name}` : site.name

  const jsonLd = (!title || canonicalPath === '/')
    ? `<script type="application/ld+json">\n{"@context":"https://schema.org","@type":"Person","name":"${(site.name || '').replace(/"/g, '\\"')}","url":"https://${site.domain}","description":"${(site.bio || '').replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 160)}"}\n</script>`
    : ''

  const ogImagePath = ogImage || '/og/index.png'
  const ogImageUrl = `https://${site.domain}${ogImagePath}`

  return fill(tpl.layout, {
    title: title ? `${title} — ${site.name}` : site.name,
    portfolioNav: portfolioNavHtml,
    content,
    name: site.name,
    domain: site.domain,
    wallet: site.wallet || '',
    blogRegistry: site.network?.blogRegistryAddress || '',
    mediaRegistry: site.network?.mediaAddress || site.media?.contractAddress || '',
    registry: site.network?.registryAddress || '',
    supporter: site.supporter ? 'true' : '',
    description,
    ogTitle,
    ogImage: ogImageUrl,
    canonicalPath: canonicalPath || '/',
    noindex: opts.noindex ? '<meta name="robots" content="noindex">' : '',
    jsonLd,
    themeBg: bg,
    themeFg: palette.fg.color,
    themeAccent: palette.accent.color,
    themeMuted: palette.muted.color,
    themeDim: palette.dim.color,
    themeSurface: palette.surface.color,
    themeBorder: palette.border.color,
    themeGreen: palette.green.color,
    themeFont: site.theme?.font || "-apple-system, 'Helvetica Neue', Arial, sans-serif",
  })
}

// --- Section page helper ---

function renderSectionPage(tpl, heading, content, title, i18nKey, site, opts = {}) {
  const headingKey = i18nKey || `nav.${heading}`
  let sectionHtml = tpl.section
  if (!i18nKey) sectionHtml = sectionHtml.replace(/ data-i18n="[^"]*"/, '')
  const inner = fill(sectionHtml, { heading: title || heading, content, headingKey })
  const ogImage = opts.ogImage || `/og/${heading}.png`
  return wrapHtml(tpl, inner, title || heading, `/${heading}`, ogImage, site, opts)
}

// --- Network/infrastructure section renderers (mirrors build.js) ---

function renderNetwork(site) {
  const addr = site.network?.registryAddress || ''
  return `<div id="network-data" data-registry="${addr}" data-chain="${site.network?.chain || 'optimism'}">
<div id="network-top-bar" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1em;gap:1ch;flex-wrap:wrap">
  <div id="network-view-toggle" style="display:flex;align-items:center;gap:0">
    <button class="network-toggle active" data-view="list" data-i18n="network.listView">list</button>
    <span style="color:var(--dim);margin:0 0.5ch">|</span>
    <button class="network-toggle" data-view="graph" data-i18n="network.graphView">graph</button>
  </div>
  <div id="network-invites-btn-row" style="display:none">
    <button id="open-invites-btn" class="buy-btn network-invites-btn" data-i18n="invites.title">invites</button>
  </div>
</div>
<div id="network-list-view">
  <p id="network-status"><span class="praxis-loader"></span></p>
  <ul id="network-list" class="reading-list"></ul>
</div>
<div id="network-graph-view" style="display:none">
  <div id="graph-container" data-registry="${addr}">
    <canvas id="graph-canvas" style="width:100%;border:1px solid #1a1a1a"></canvas>
    <p id="graph-status" style="color:var(--muted);font-size:0.85em;margin-top:0.5em"></p>
  </div>
</div>
</div>`
}

function renderCollaborate(site) {
  const praxisAddr = site.network?.praxisAddress || ''
  const regAddr = site.network?.registryAddress || ''
  return `<div id="collab-data" data-hub="${praxisAddr}" data-registry="${regAddr}">
<p style="color:var(--dim);font-size:0.85em;max-width:50ch;margin:0.25em 0 1.5em;line-height:1.5">propose, fund, and produce creative work together. 100% of funding goes directly to the team. <a href="https://ourpraxis.network/how-it-works#projects" target="_blank" style="color:var(--accent)">learn more</a></p>
<div id="projects-header" style="position:sticky;top:0;z-index:10;background:var(--bg);padding:1em 0 0.5em">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <p id="collab-status" style="color:var(--muted);margin:0"></p>
    <div id="collab-propose-form"></div>
  </div>
  <div id="projects-view-toggle" style="margin:0.75em 0 0.5em">
    <button class="projects-toggle active" data-view="list" data-i18n="projects.listView">list</button>
    <span style="color:var(--dim);margin:0 0.5ch">|</span>
    <button class="projects-toggle" data-view="map" data-i18n="projects.mapView">map</button>
  </div>
  <div id="projects-list-filters" style="display:flex;gap:0.75ch;flex-wrap:wrap">
    <button class="projects-list-filter active" data-list-filter="active" data-i18n="build.activeProposals">active</button>
    <button class="projects-list-filter" data-list-filter="mine" data-i18n="build.yourProjects">yours</button>
    <button class="projects-list-filter" data-list-filter="contributions" data-i18n="build.yourContributions">contributions</button>
  </div>
  <input type="text" id="projects-search" placeholder="search projects..." style="width:100%;background:transparent;border:1px solid var(--border);color:var(--fg);font-family:inherit;font-size:0.85em;padding:0.4em 1ch;margin-top:0.5em" data-i18n-placeholder="projects.searchPlaceholder">
</div>
<div id="projects-list-view" style="margin-top:1em">
  <div id="collab-loader"><span class="praxis-loader"></span></div>
  <div id="collab-active"></div>
  <div id="collab-mine" style="display:none"></div>
  <div id="collab-contributions" style="display:none"></div>
</div>
<div id="projects-map-view" style="display:none">
  <div id="projects-map-filters" class="projects-map-filters">
    <button class="projects-filter active" data-filter="all" data-i18n="projects.filterAll">all</button>
    <button class="projects-filter" data-filter="nearby" data-i18n="projects.nearby">nearby</button>
    <span style="color:var(--dim);margin:0 0.5ch">|</span>
    <button class="projects-filter" data-status="0" data-i18n="projects.status.proposed">proposed</button>
    <button class="projects-filter" data-status="1" data-i18n="projects.status.funded">funded</button>
    <button class="projects-filter" data-status="2" data-i18n="projects.status.confirmed">confirmed</button>
    <button class="projects-filter" data-status="4" data-i18n="projects.status.completed">completed</button>
  </div>
  <div id="projects-map" style="height:500px;border:1px solid var(--border);margin-bottom:1em"></div>
  <div id="projects-no-location"></div>
</div>
</div>`
}

function renderLibrary(site) {
  const libAddr = site.network?.libraryRegistryAddress || ''
  return `<div id="library-data" data-address="${libAddr}">
<p id="library-status"><span class="praxis-loader"></span></p>
<div id="library-add-form" style="margin-bottom:2em"></div>
<div id="library-list"></div>
</div>`
}

// --- Static page renderers (journal, collection, works, etc. — shell HTML) ---

const STATIC_PAGES = {
  journal(site) {
    return {
      content: `<div id="journal-page">
<p id="journal-status" style="color:var(--muted)" data-i18n="journal.connectOwner"></p>
<div id="journal-content"></div>
</div>`,
      title: 'journal',
      path: '/journal',
      ogImage: '/og/index.png',
      opts: { noindex: true },
    }
  },
  collection(site) {
    return {
      content: `<div id="collection-page">
<p id="collection-status" style="color:var(--muted)"><span class="praxis-loader"></span></p>
<div id="collection-content"></div>
</div>`,
      title: 'collection',
      path: '/collection',
      ogImage: '/og/collection.svg',
      opts: { description: `media and credentials collected by ${site.name}.` },
    }
  },
  works(site) {
    return {
      content: `<div id="works-page">
<h2 data-i18n="works.title">works for sale</h2>
<p style="color:var(--dim);font-size:0.85em;max-width:50ch;margin:0.25em 0 1.5em;line-height:1.5">collect music, video, and art directly from the artist. 100% of every purchase goes to the creator. <a href="https://ourpraxis.network/how-it-works#soulbound" target="_blank" style="color:var(--accent)">learn more</a></p>
<p id="works-status" style="color:var(--muted)"><span class="praxis-loader"></span></p>
<div id="works-content"></div>
</div>`,
      title: 'works',
      path: '/works',
      ogImage: '/og/index.png',
      opts: { description: `works for sale by ${site.name}. music, video, art with collaborator splits.` },
    }
  },
  org(site) {
    return {
      content: `<div id="org-page"><span class="praxis-loader"></span></div>`,
      title: 'org',
      path: '/org',
      ogImage: '/og/index.png',
      opts: { description: `organizations on ${site.name}'s network.` },
    }
  },
  art(site) {
    return {
      content: `<div id="art-page"><div id="art-loading"><span class="praxis-loader"></span></div><div id="art-content"></div></div>`,
      title: 'art',
      path: '/art',
      ogImage: '/og/index.png',
      opts: {},
    }
  },
  earnings(site) {
    return {
      content: `<div id="earnings-page" style="max-width:680px;margin:0 auto">
<h2 data-i18n="earnings.title">earnings</h2>
<div id="earnings-content"><span class="praxis-loader"></span></div>
</div>`,
      title: 'earnings',
      path: '/earnings',
      ogImage: '/og/index.png',
      opts: { noindex: true },
    }
  },
  write(site) {
    return {
      content: `<div id="write-page">
<div class="write-inner">
  <div class="write-header">
    <button id="compose-close" class="write-back-btn" aria-label="back"><i class="ph ph-arrow-left"></i></button>
    <div class="write-actions">
      <a href="https://ourpraxis.network/how-it-works#writing" target="_blank" style="color:var(--dim);font-size:0.75em;text-decoration:none">what's this?</a>
      <button id="compose-preview-toggle" class="write-btn write-btn-secondary">preview</button>
      <button id="compose-post" class="write-btn write-btn-primary">publish</button>
    </div>
  </div>
  <span class="compose-label" id="write-header-label" style="display:none"></span>
  <div class="write-format-bar">
    <button class="compose-fmt" data-wrap="**" title="bold"><b>B</b></button>
    <button class="compose-fmt" data-wrap="*" title="italic"><i>I</i></button>
    <button class="compose-fmt" data-prefix="## " title="heading">H</button>
    <button class="compose-fmt" data-prefix="> " title="quote"><i class="ph ph-quotes"></i></button>
    <button class="compose-fmt" data-link="true" title="link"><i class="ph ph-link-simple"></i></button>
    <button id="compose-image" class="compose-fmt" title="image"><i class="ph ph-image"></i></button>
    <span style="flex:1"></span>
    <button id="compose-ref" class="compose-fmt" title="search people, media, references"><i class="ph ph-at"></i></button>
    <span id="compose-ref-label" style="color:var(--dim);font-size:0.75em"></span>
  </div>
  <div class="write-editor">
    <input type="text" id="compose-title" class="write-title" placeholder="title" autocomplete="off">
    <textarea id="compose-content" class="write-content" placeholder="start writing..."></textarea>
    <div id="compose-preview" class="compose-preview" style="display:none"></div>
    <div id="compose-ref-card-slot"></div>
    <div id="compose-ref-picker" style="display:none"></div>
  </div>
  <p id="compose-status" style="color:var(--muted);font-size:0.85em;margin-top:auto;padding:0.5em 0"></p>
</div>
</div>`,
      title: 'write',
      path: '/write',
      ogImage: '/og/index.png',
      opts: { noindex: true },
    }
  },
  propose(site) {
    return {
      content: `<div id="propose-page" style="max-width:680px;margin:0 auto;padding:2em 0"></div>`,
      title: 'propose a project',
      path: '/propose',
      ogImage: '/og/index.png',
      opts: { noindex: true, description: 'propose a new creative project' },
    }
  },
  notifications(site) {
    return {
      content: `<div id="notifications-page" style="max-width:680px;margin:0 auto">
<h2 data-i18n="notifications.title">notifications</h2>
<div id="notifications-content"><span class="praxis-loader"></span></div>
</div>`,
      title: 'notifications',
      path: '/notifications',
      ogImage: '/og/index.png',
      opts: { noindex: true },
    }
  },
  messages(site) {
    return {
      content: `<div id="messages-page">
<div id="messages-container" class="messages-container">
  <div id="messages-sidebar" class="messages-sidebar">
    <div class="messages-sidebar-header" style="display:flex;align-items:center;justify-content:space-between">
      <span data-i18n="messages.title">messages</span>
      <div style="display:flex;align-items:center;gap:0">
        <button id="messages-compose" style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0.2em;font-family:inherit;min-width:36px;min-height:36px;display:inline-flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent"><i class="ph ph-plus-circle" style="font-size:28px"></i></button>
        <button id="messages-settings-btn" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:0.2em;min-width:36px;min-height:36px;display:inline-flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent"><i class="ph ph-gear" style="font-size:28px"></i></button>
      </div>
    </div>
    <div id="messages-connect" style="padding:1em;color:var(--muted);display:none" data-i18n="messages.connectToMessage">connect wallet to message</div>
    <div id="messages-loading" style="padding:1em"><span class="praxis-loader"></span></div>
    <div id="messages-list"></div>
    <div id="messages-new-picker" style="display:none"></div>
  </div>
  <div id="messages-chat" class="messages-chat">
    <div id="messages-chat-empty" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--dim)" data-i18n="messages.selectConversation">select a conversation</div>
    <div id="messages-chat-active" style="display:none">
      <div class="messages-chat-header">
        <button id="messages-back" class="messages-back-btn" style="display:none"><i class="ph ph-arrow-left"></i></button>
        <span id="messages-peer-name"></span>
      </div>
      <div id="messages-msgs" class="messages-msgs"></div>
      <div id="messages-pay-bar" class="messages-pay-bar" style="display:none">
        <div style="display:flex;align-items:center;gap:0.75ch;flex:1;background:var(--surface,#111);border:1px solid var(--border,#333);border-radius:8px;padding:0.4em 0.75ch">
          <i class="ph ph-currency-eth" style="color:var(--accent);font-size:1em"></i>
          <input type="text" id="messages-pay-amount" placeholder="0.00" style="flex:1;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.95em;padding:0;outline:none;min-width:4ch" inputmode="decimal">
          <span id="messages-pay-fiat" style="color:var(--dim);font-size:0.8em;white-space:nowrap"></span>
          <span style="color:var(--dim);font-size:0.8em">ETH</span>
        </div>
        <button id="messages-pay-send" style="background:none;border:1px solid var(--accent,#fff);color:var(--accent,#fff);font-family:inherit;font-size:0.85em;padding:0.4em 1.2ch;cursor:pointer;border-radius:6px;white-space:nowrap"><i class="ph ph-paper-plane-tilt" style="margin-right:0.3ch"></i> send</button>
        <button id="messages-pay-cancel" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:1em;padding:0.2em"><i class="ph ph-x"></i></button>
      </div>
      <form id="messages-send-form" class="messages-send-form">
        <button type="button" id="messages-pay-toggle" class="dock-btn" title="send ETH" style="font-size:1em"><i class="ph ph-currency-eth"></i></button>
        <textarea id="messages-input" rows="1" placeholder="type a message..." autocomplete="off" data-i18n-placeholder="messages.placeholder" style="resize:none;overflow-y:hidden;min-height:1.8em;max-height:8em;line-height:1.4;border-radius:20px;padding:0.5em 1em"></textarea>
        <button type="button" id="messages-attach-btn" class="dock-btn" title="attach" style="font-size:1em"><i class="ph ph-paperclip"></i></button>
        <input type="file" id="messages-attach-input" accept="image/*,video/*,.pdf" style="display:none" multiple>
      </form>
    </div>
  </div>
</div>
<template id="messages-chat-template">
    <div id="messages-chat-empty" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--dim)" data-i18n="messages.selectConversation">select a conversation</div>
    <div id="messages-chat-active" style="display:none">
      <div class="messages-chat-header">
        <button id="messages-back" class="messages-back-btn" style="display:none"><i class="ph ph-arrow-left"></i></button>
        <span id="messages-peer-name"></span>
      </div>
      <div id="messages-msgs" class="messages-msgs"></div>
      <div id="messages-pay-bar" class="messages-pay-bar" style="display:none">
        <div style="display:flex;align-items:center;gap:0.75ch;flex:1;background:var(--surface,#111);border:1px solid var(--border,#333);border-radius:8px;padding:0.4em 0.75ch">
          <i class="ph ph-currency-eth" style="color:var(--accent);font-size:1em"></i>
          <input type="text" id="messages-pay-amount" placeholder="0.00" style="flex:1;background:none;border:none;color:var(--fg);font-family:inherit;font-size:0.95em;padding:0;outline:none;min-width:4ch" inputmode="decimal">
          <span id="messages-pay-fiat" style="color:var(--dim);font-size:0.8em;white-space:nowrap"></span>
          <span style="color:var(--dim);font-size:0.8em">ETH</span>
        </div>
        <button id="messages-pay-send" style="background:none;border:1px solid var(--accent,#fff);color:var(--accent,#fff);font-family:inherit;font-size:0.85em;padding:0.4em 1.2ch;cursor:pointer;border-radius:6px;white-space:nowrap"><i class="ph ph-paper-plane-tilt" style="margin-right:0.3ch"></i> send</button>
        <button id="messages-pay-cancel" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:1em;padding:0.2em"><i class="ph ph-x"></i></button>
      </div>
      <form id="messages-send-form" class="messages-send-form">
        <button type="button" id="messages-pay-toggle" class="dock-btn" title="send ETH" style="font-size:1em"><i class="ph ph-currency-eth"></i></button>
        <textarea id="messages-input" rows="1" placeholder="type a message..." autocomplete="off" data-i18n-placeholder="messages.placeholder" style="resize:none;overflow-y:hidden;min-height:1.8em;max-height:8em;line-height:1.4;border-radius:20px;padding:0.5em 1em"></textarea>
        <button type="button" id="messages-attach-btn" class="dock-btn" title="attach" style="font-size:1em"><i class="ph ph-paperclip"></i></button>
        <input type="file" id="messages-attach-input" accept="image/*,video/*,.pdf" style="display:none" multiple>
      </form>
    </div>
</template>
</div>`,
      title: 'messages',
      path: '/messages',
      ogImage: '/og/messages.svg',
      opts: { noindex: true },
    }
  },
  project(site) {
    const praxisAddr = site.network?.praxisAddress || ''
    const regAddr = site.network?.registryAddress || ''
    const blogRegistryAddr = site.network?.blogRegistryAddress || ''
    return {
      content: `<div id="project-detail-page" data-praxis="${praxisAddr}" data-registry="${regAddr}" data-blog="${blogRegistryAddr}">
  <p id="project-detail-loading"><span class="praxis-loader"></span></p>
  <div id="project-detail-content"></div>
</div>`,
      title: 'project',
      path: '/project',
      ogImage: '/og/project.svg',
      opts: { description: 'creative project on praxis.' },
    }
  },
  post(site) {
    const blogRegistryAddr = site.network?.blogRegistryAddress || ''
    return {
      content: `<article id="post-page" data-blog="${blogRegistryAddr}">
  <p id="post-loading"><span class="praxis-loader"></span></p>
  <div id="post-content"></div>
</article>`,
      title: 'post',
      path: '/post',
      ogImage: '/og/post.svg',
      opts: { description: `blog post by ${site.name}.` },
    }
  },
}

// --- Main render function ---

/**
 * Render a page dynamically from a cached template shell + site.json data.
 *
 * @param {string} templateName - Template type (default, musician, visual, etc.)
 * @param {string} pageName - Page to render (index, network, projects, library, or module route)
 * @param {object} siteData - Parsed site.json
 * @param {string} rootDir - Path to the main dist/ directory (for shared assets)
 * @returns {string|null} Complete HTML string, or null if page not found
 */
export function renderPage(templateName, pageName, siteData, rootDir) {
  const tpl = loadTemplate(templateName, rootDir)
  if (!tpl) return null

  // Normalize: strip leading slash, default to 'index'
  const page = (pageName || 'index').replace(/^\/+/, '') || 'index'

  // --- Index page ---
  if (page === 'index' || page === '') {
    const blogRegistryAddr = siteData.network?.blogRegistryAddress || ''

    let indexContent
    if (siteData.supporter) {
      // Supporter homepage
      const topArtists = siteData.topArtists || []
      let artistCardsHtml = ''
      const actualArtists = topArtists.filter(a => a?.domain)
      for (const artist of actualArtists) {
        const domain = artist.domain
        artistCardsHtml += `<a href="https://${escapeForHtml(domain)}" class="top-artist-card" data-domain="${escapeForHtml(domain)}" target="_blank" rel="noopener">
          <img class="top-artist-avatar" src="https://${escapeForHtml(domain)}/og/index.png" alt="${escapeForHtml(domain)}" loading="lazy" style="width:100%;aspect-ratio:1200/630;object-fit:cover;border-radius:6px">
          <span class="top-artist-name">${escapeForHtml(artist.name || domain)}</span>
        </a>`
      }
      const myArtistsSection = actualArtists.length > 0
        ? `<div class="my-artists-section"><h3>my artists</h3><div id="top-artists-grid" class="top-artists-grid">${artistCardsHtml}</div></div>`
        : ''
      indexContent = `<header style="padding-left:0;margin-bottom:2em">
  <h1>${escapeForHtml(siteData.name)}</h1>
  <p class="bio">${siteData.bio || ''}</p>
  <div id="owner-badges"></div>
</header>
${myArtistsSection}
<div id="feed" data-blog="${blogRegistryAddr}" data-owner="${siteData.wallet || ''}" style="display:none">
  <p id="feed-status" style="color:var(--muted)"><span class="praxis-loader"></span></p>
  <div id="feed-posts"></div>
</div>
<div id="supporter-collection-section" data-wallet="${siteData.wallet || ''}">
  <p id="supporter-collection-status" style="color:var(--muted)"><span class="praxis-loader"></span></p>
  <div id="masonry-grid" class="masonry-grid"></div>
</div>`
    } else {
      const { html: highlightsHtml, highlightedTypes } = buildHighlights(siteData)
      const cvHtml = buildCV(siteData, highlightedTypes)
      indexContent = fill(tpl.index, {
        name: escapeForHtml(siteData.name),
        bio: escapeForHtml(siteData.bio || siteData.shortBio || ''),
        shortBio: escapeForHtml(siteData.shortBio || siteData.bio || ''),
        highlights: highlightsHtml,
        cv: cvHtml,
        blogRegistry: blogRegistryAddr,
        wallet: siteData.wallet || '',
        representation: escapeForHtml(siteData.representation || ''),
        tagline: escapeForHtml(siteData.tagline || ''),
        reel: siteData.reel || '',
        profilePic: siteData.profilePic || '',
      })
    }
    return wrapHtml(tpl, indexContent, null, '/', '/og/index.png', siteData)
  }

  // --- Blog index page ---
  if (page === 'blog') {
    const blogCollections = siteData.blogCollections || []
    const blogPostCollections = siteData.blogPostCollections || {}
    const blogCollectionsJson = JSON.stringify(blogCollections).replace(/</g, '\\u003c')
    const blogPostCollectionsJson = JSON.stringify(blogPostCollections).replace(/</g, '\\u003c')
    const blogIndexHtml = fill(tpl.blogIndex, {})
    const blogDataScript = blogCollections.length > 0
      ? `<script>window.__blogCollections=${blogCollectionsJson};window.__blogPostCollections=${blogPostCollectionsJson};</script>`
      : ''
    return wrapHtml(tpl, blogDataScript + blogIndexHtml, 'blog', '/blog', '/og/blog.svg', siteData, { description: `blog posts by ${siteData.name}.` })
  }

  // --- Blog collection pages ---
  if (page.startsWith('blog/')) {
    const colSlug = page.slice(5)
    const blogCollections = siteData.blogCollections || []
    const blogPostCollections = siteData.blogPostCollections || {}
    const col = blogCollections.find(c => (c.slug || c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) === colSlug)
    if (!col) return null
    const blogCollectionsJson = JSON.stringify(blogCollections).replace(/</g, '\\u003c')
    const blogPostCollectionsJson = JSON.stringify(blogPostCollections).replace(/</g, '\\u003c')
    const colDataScript = `<script>window.__blogCollections=${blogCollectionsJson};window.__blogPostCollections=${blogPostCollectionsJson};window.__blogActiveCollection="${colSlug.replace(/"/g, '')}";</script>`
    const colHtml = `<section>
  <h1>${escapeForHtml(col.name)}</h1>
  ${col.description ? `<p style="color:var(--muted);margin-bottom:1.5em">${escapeForHtml(col.description)}</p>` : ''}
  <div id="blog-collection-filters"></div>
  <div id="onchain-posts"></div>
</section>`
    return wrapHtml(tpl, colDataScript + colHtml, col.name, `/blog/${colSlug}`, '/og/blog.svg', siteData, { description: col.description || `${col.name} — blog posts by ${siteData.name}.` })
  }

  // --- Network infrastructure sections ---
  if (page === 'network') {
    return renderSectionPage(tpl, 'network', renderNetwork(siteData), undefined, undefined, siteData, { description: `discover artists on ${siteData.name}'s network. follow, connect, and collaborate.` })
  }
  if (page === 'projects') {
    return renderSectionPage(tpl, 'projects', renderCollaborate(siteData), undefined, undefined, siteData, { description: `collaborative creative projects by ${siteData.name}. propose, fund, and build together.` })
  }
  if (page === 'library') {
    return renderSectionPage(tpl, 'library', renderLibrary(siteData), undefined, undefined, siteData, { description: `shared knowledge base. PDFs, articles, and essays curated by ${siteData.name}.` })
  }

  // --- Static/shell pages (journal, collection, works, messages, etc.) ---
  if (STATIC_PAGES[page]) {
    const def = STATIC_PAGES[page](siteData)
    return wrapHtml(tpl, def.content, def.title, def.path, def.ogImage, siteData, def.opts)
  }

  // --- Module section pages ---
  for (const moduleEntry of getEnabledModules(siteData)) {
    const mod = MODULE_REGISTRY[moduleEntry.type]
    const route = mod.route.slice(1) // strip leading /
    if (page === route) {
      const content = mod.renderSection(moduleEntry.data)
      if (!content) return null
      const label = getTemplateLabel(templateName, moduleEntry.type, moduleEntry)
      const i18nKey = moduleEntry.customLabel ? null : `module.${moduleEntry.type}`
      // Use first video/film thumbnail as OG image if available
      let sectionOgImage = null
      if (moduleEntry.type === 'film' || moduleEntry.type === 'video') {
        const works = moduleEntry.data?.works || moduleEntry.data?.videos || []
        for (const w of works) {
          const cid = w.video?.match?.(/ipfs-proxy\/([A-Za-z0-9]+)/)?.[1] || w.src?.match?.(/ipfs-proxy\/([A-Za-z0-9]+)/)?.[1]
          if (cid) { sectionOgImage = `/api/video-thumb?cid=${cid}&w=1200`; break }
          if (w.poster) { sectionOgImage = w.poster; break }
        }
      } else if (moduleEntry.type === 'music') {
        const aliases = moduleEntry.data?.aliases || []
        for (const a of aliases) {
          for (const al of (a.albums || [])) {
            if (al.art) { sectionOgImage = al.art.startsWith('/') ? al.art : `/api/img?url=${encodeURIComponent(al.art)}&w=1200`; break }
          }
          if (sectionOgImage) break
        }
      } else if (moduleEntry.type === 'gallery') {
        const images = moduleEntry.data?.images || []
        if (images[0]?.src) sectionOgImage = `/api/img?url=${encodeURIComponent(images[0].src)}&w=1200`
      }
      const opts = sectionOgImage ? { ogImage: sectionOgImage } : {}
      return renderSectionPage(tpl, route, content, label, i18nKey, siteData, opts)
    }
  }

  // --- Reading list ---
  if (page === 'reading') {
    // At serve time we don't have the reading list file, render empty shell
    const readingHtml = fill(tpl.reading, { items: '' })
    return wrapHtml(tpl, readingHtml, 'reading list', '/reading', '/og/index.png', siteData)
  }

  return null
}

// --- Apply asset manifest fingerprinting to rendered HTML ---

export function applyAssetManifest(html, templateName, rootDir) {
  const tpl = loadTemplate(templateName, rootDir)
  if (!tpl?.assetManifest || !Object.keys(tpl.assetManifest).length) return html

  let result = html
  for (const [original, hashed] of Object.entries(tpl.assetManifest)) {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`((?:src|href)=")${escaped}(")`, 'g'), `$1${hashed}$2`)
  }
  return result
}

// --- Clear template cache (for hot reload during development) ---

export function clearTemplateCache() {
  _templateCache.clear()
}
