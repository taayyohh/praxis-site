import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, renameSync, unlinkSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { brotliCompressSync, gzipSync, constants } from 'zlib'
import { MODULE_REGISTRY, LEGACY_TYPE_MAP } from './modules/index.js'
import { deriveFullPalette } from './public/js/contrast.js'

// bundle viem vendor file (esm.sh → local) — skip if already built (Fix 10)
const _vendorPath = join('public', 'js', 'vendor.js')
if (existsSync(_vendorPath) && statSync(_vendorPath).size > 0) {
  console.log('vendor bundles exist, skipping rebuild')
} else {
  try {
    execSync('node scripts/bundle-vendor.js', { stdio: 'inherit' })
  } catch (e) {
    console.warn('vendor bundle failed:', e.message)
  }
}

// self-host Phosphor Icons (CSS + fonts) — skip if already fetched
const _phosphorCss = join('public', 'phosphor.css')
if (existsSync(_phosphorCss) && statSync(_phosphorCss).size > 0) {
  console.log('phosphor icons exist, skipping fetch')
} else {
  try {
    execSync('node scripts/fetch-phosphor.js', { stdio: 'inherit' })
  } catch (e) {
    console.warn('phosphor icons fetch failed:', e.message)
  }
}

const site = JSON.parse(readFileSync(process.env.SITE_JSON || 'site.json', 'utf8'))
const distDir = process.env.DIST_DIR || 'dist'

// --- Module system ---

// load modules from site.json (supports both new and legacy formats)
function loadModules() {
  if (site.modules) return site.modules
  // legacy: convert old flat structure to modules array
  const modules = []
  let order = 1
  const nav = site.nav || []

  // music — only include if there are actual aliases with content
  const musicAliases = site.music?.aliases || []
  if (musicAliases.length) modules.push({ type: 'music', enabled: nav.includes('music'), order: order++, data: site.music })

  // theater/film/tv → credits
  const credits = []
  if (site.theater) {
    for (const c of (site.theater.acting || [])) credits.push({ title: c.production, role: c.role, org: c.company, year: c.year, category: 'theater' })
    for (const c of (site.theater.composing || [])) credits.push({ title: c.description, role: 'composer', category: 'theater' })
  }
  if (site.film) for (const f of site.film) credits.push({ title: f.title, role: f.role, org: f.director ? `dir. ${f.director}` : '', year: f.year, category: 'film' })
  if (site.tv) for (const t of site.tv) credits.push({ title: t.title, role: t.role, org: t.note || '', year: t.year, category: 'tv' })
  if (credits.length) modules.push({ type: 'credits', enabled: true, order: order++, data: credits })

  // engineering + portfolio → technology
  const techItems = [...(site.engineering || []), ...(site.portfolio || [])]
  if (techItems.length) modules.push({ type: 'technology', enabled: nav.includes('engineering') || nav.includes('portfolio'), order: order++, data: techItems })

  return modules
}

const siteModules = loadModules()

function getEnabledModules() {
  return siteModules.filter(m => m.enabled && MODULE_REGISTRY[m.type]).sort((a, b) => (a.order || 99) - (b.order || 99))
}

// Template-aware label overrides for portfolio nav and dock section links
const TEMPLATE_LABELS = {
  musician:  { music: 'discography', audio: 'discography', demos: 'demos' },
  filmmaker: { video: 'films', gallery: 'portfolio', demos: 'dailies' },
  visual:    { gallery: 'portfolio', demos: 'sketches' },
  writer:    { writing: 'writing', gallery: 'gallery', demos: 'drafts' },
  performer: { demos: 'rehearsals' },
}

function getTemplateLabel(moduleType, moduleEntry) {
  if (moduleEntry?.customLabel) return escapeForHtml(moduleEntry.customLabel)
  const overrides = TEMPLATE_LABELS[templateName] || {}
  return overrides[moduleType] || MODULE_REGISTRY[moduleType]?.label || moduleType
}

function buildPortfolioNav() {
  const moduleLinks = getEnabledModules().map(m => {
    const mod = MODULE_REGISTRY[m.type]
    const label = getTemplateLabel(m.type, m)
    const i18nAttr = m.customLabel ? '' : ` data-i18n="module.${m.type}"`
    return `<a href="${mod.route}"${i18nAttr}>${label}</a>`
  }).join(' ')
  // Always show "blog" in the portfolio nav so signed-out visitors can
  // find the artist's blog (the dock is owner-only so visitors can't see
  // the blog icon there). Placed after all module links.
  return moduleLinks + ' <a href="/blog" data-i18n="nav.blog">blog</a>'
}

// Tracks which module types were rendered into the homepage highlights
// strip, so buildCV() can skip them and avoid duplicate sections (e.g. a
// "credits" highlights box followed by an identically-titled "credits" CV
// section, which previously rendered the exact same content twice on
// milesxb.bio's homepage).
const _highlightedTypes = new Set()

function buildHighlights() {
  _highlightedTypes.clear()
  let html = ''
  for (const moduleEntry of getEnabledModules()) {
    // showOnHomepage defaults to true for backwards compatibility
    if (moduleEntry.showOnHomepage === false) continue
    const mod = MODULE_REGISTRY[moduleEntry.type]
    if (!mod?.renderHighlights) continue
    const content = mod.renderHighlights(moduleEntry.data)
    if (!content) continue
    const heading = getTemplateLabel(moduleEntry.type, moduleEntry)
    html += `<div class="highlights-section"><h3>${heading}</h3>${content}<a href="${mod.route}" class="highlights-view-all">view all \u2192</a></div>`
    _highlightedTypes.add(moduleEntry.type)
  }
  return html
}

function buildCV() {
  // CV sections: only modules with showOnHomepage !== false, in module order
  const cvSections = getEnabledModules()
    .filter(m => m.showOnHomepage !== false)
    .map(m => m.type)
  let html = '<div class="cv">'
  for (const type of cvSections) {
    // skip module types already rendered in highlights — otherwise the
    // same heading + content shows up twice on the homepage
    if (_highlightedTypes.has(type)) continue
    const moduleEntry = siteModules.find(m => m.type === type && m.enabled)
    if (!moduleEntry) continue
    const mod = MODULE_REGISTRY[type]
    if (!mod?.renderCV) continue
    const content = mod.renderCV(moduleEntry.data)
    const cvLabel = getTemplateLabel(type, moduleEntry)
    if (content) html += `<div class="cv-section"><h3>${cvLabel}</h3>${content}</div>`
  }
  html += '</div>'
  return html
}

const templateName = site.template || 'default'
const templateDir = existsSync(`templates/${templateName}`) ? `templates/${templateName}` : 'templates/default'

const layout = readFileSync(join(templateDir, 'layout.html'), 'utf8')
const indexTpl = readFileSync(join(templateDir, 'index.html'), 'utf8')
const sectionTpl = readFileSync(join(templateDir, 'section.html'), 'utf8')
const blogIndexTpl = existsSync(join(templateDir, 'blog-index.html'))
  ? readFileSync(join(templateDir, 'blog-index.html'), 'utf8')
  : readFileSync('templates/default/blog-index.html', 'utf8')
const readingTpl = existsSync(join(templateDir, 'reading.html'))
  ? readFileSync(join(templateDir, 'reading.html'), 'utf8')
  : readFileSync('templates/default/reading.html', 'utf8')

// --- OG image generation ---

// OG image generation using Satori (HTML→SVG with embedded fonts) + resvg (SVG→PNG)
// Same approach as Vercel OG but self-hosted, no vendor dependency

let _satori = null
let _resvg = null
let _fontData = null

async function loadOgDeps() {
  if (!_satori) {
    _satori = (await import('satori')).default
    _resvg = (await import('@resvg/resvg-js')).Resvg
    // load font from local file (committed to repo — no network needed)
    try {
      _fontData = readFileSync(join('public', 'fonts', 'JetBrainsMono-Regular.ttf'))
    } catch (e) {
      console.warn('OG font not found:', e.message)
      return
    }
  }
}

async function generateOgPng({ title, subtitle, footer, isInvite }) {
  await loadOgDeps()
  const domain = site.domain || ''
  const theme = site.theme || {}

  const html = isInvite ? {
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', height: '100%', background: '#0a0a0a', padding: '80px', fontFamily: 'JetBrains Mono' },
      children: [
        { type: 'div', props: { style: { color: '#00ff41', fontSize: 44, fontWeight: 'bold' }, children: "you've been invited." } },
        { type: 'div', props: { style: { color: '#ffffff', fontSize: 28, marginTop: 80 }, children: 'praxis' } },
        { type: 'div', props: { style: { color: '#555', fontSize: 22, marginTop: 16 }, children: 'a network for artists' } },
        { type: 'div', props: { style: { color: '#555', fontSize: 22, marginTop: 8 }, children: 'finding, articulating, and manifesting their practice.' } },
        { type: 'div', props: { style: { color: '#333', fontSize: 18, position: 'absolute', bottom: 40, left: 80 }, children: 'ourpraxis.network' } },
      ],
    },
  } : (() => {
    // Detect if bg is light — if so, use dark text for contrast
    const bgHex = (theme.bg || '#0a0a0a').replace('#', '')
    const r = parseInt(bgHex.slice(0, 2), 16) || 0
    const g = parseInt(bgHex.slice(2, 4), 16) || 0
    const b = parseInt(bgHex.slice(4, 6), 16) || 0
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    const isLight = luminance > 0.5
    // Keep the site's bg; flip text to dark if bg is light
    const ogBg = theme.bg || '#0a0a0a'
    const ogFg = isLight ? '#111111' : (theme.fg || '#ffffff')
    const ogAccent = isLight ? '#333333' : (theme.accent || '#00ff41')
    const ogDim = isLight ? '#555555' : (theme.dim || '#555')
    return {
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', height: '100%', background: ogBg, padding: '80px', fontFamily: 'JetBrains Mono' },
        children: [
          title ? { type: 'div', props: { style: { color: ogFg, fontSize: 48, fontWeight: 'bold' }, children: title } } : null,
          subtitle ? { type: 'div', props: { style: { color: ogAccent, fontSize: 28, marginTop: 24 }, children: subtitle } } : null,
          footer ? { type: 'div', props: { style: { color: ogDim, fontSize: 22, marginTop: 24 }, children: footer } } : null,
          { type: 'div', props: { style: { display: 'flex', justifyContent: 'space-between', position: 'absolute', bottom: 40, left: 80, right: 80 }, children: [
            { type: 'div', props: { style: { color: ogDim, fontSize: 18 }, children: 'praxis' } },
            { type: 'div', props: { style: { color: ogDim, fontSize: 18 }, children: domain } },
          ] } },
        ].filter(Boolean),
      },
    }
  })()

  const svg = await _satori(html, {
    width: 1200,
    height: 630,
    fonts: [{ name: 'JetBrains Mono', data: _fontData, weight: 400, style: 'normal' }],
  })

  const resvg = new _resvg(svg, { fitTo: { mode: 'width', value: 1200 } })
  return resvg.render().asPng()
}

async function svgToPng(opts, outPath) {
  try {
    const png = await generateOgPng(opts)
    writeFileSync(outPath, png)
  } catch (e) {
    console.warn(`OG generation failed for ${outPath}: ${e.message}`)
  }
}

async function buildOgImages() {
  const ogDir = join(distDir, 'og')
  mkdirSync(ogDir, { recursive: true })

  const pngs = []

  function addOg(name, opts) {
    const ogOpts = name === 'invite' ? { isInvite: true } : opts
    pngs.push(svgToPng(ogOpts, join(ogDir, `${name}.png`)))
  }

  // homepage — truncate bio at sentence or word boundary
  const rawBio = site.bio || ''
  let ogBio = rawBio
  if (ogBio.length > 100) {
    // Try sentence boundary within 140 chars
    const cut = ogBio.slice(0, 140)
    const lastSentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'))
    if (lastSentence > 30) {
      ogBio = ogBio.slice(0, lastSentence + 1)
    } else {
      // Fall back to word boundary
      const wordCut = ogBio.slice(0, 110).replace(/\s+\S*$/, '')
      ogBio = wordCut.length > 30 ? wordCut + '...' : ogBio.slice(0, 100) + '...'
    }
  }
  addOg('index', { title: site.name, subtitle: ogBio })

  // module-based sections
  for (const moduleEntry of getEnabledModules()) {
    const mod = MODULE_REGISTRY[moduleEntry.type]
    const route = mod.route.slice(1)
    addOg(route, { title: mod.label, footer: site.name })
  }

  addOg('network', { title: 'the network', subtitle: 'artists connected on Ethereum', footer: site.name })
  addOg('projects', { title: 'projects', subtitle: 'propose, fund, build, complete', footer: site.name })
  addOg('library', { title: 'library', subtitle: 'shared knowledge', footer: site.name })
  addOg('messages', { title: 'messages', subtitle: 'encrypted conversations', footer: site.name })
  addOg('blog', { title: 'feed', subtitle: 'posts from the network', footer: site.name })
  addOg('collection', { title: 'collection', subtitle: 'credentials and media', footer: site.name })
  addOg('post', { title: 'post', subtitle: site.name })
  addOg('project', { title: 'project', subtitle: site.name })
  addOg('invite', {}) // uses generateInviteOgSvg via the name check

  await Promise.all(pngs)
  console.log(`generated ${pngs.length} OG images (SVG + PNG) → ${distDir}/og/`)
}

// helpers

function escapeForHtml(s) {
  if (!s) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

function wrap(content, title, canonicalPath, ogImage, { description: descOverride, noindex } = {}) {
  const portfolioNavHtml = buildPortfolioNav()

  const bg = site.theme?.bg || '#0a0a0a'
  const fg = site.theme?.fg || '#c0c0c0'
  const accent = site.theme?.accent || '#ffffff'
  const palette = deriveFullPalette(bg, fg, accent)

  const description = escapeForHtml(descOverride || site.bio?.slice(0, 160) || '')
  const ogTitle = escapeForHtml(title ? `${title} — ${site.name}` : site.name)

  // JSON-LD structured data (homepage only)
  const jsonLd = (!title || canonicalPath === '/')
    ? `<script type="application/ld+json">\n${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Person', name: site.name || '', url: `https://${site.domain}`, description: (site.bio || '').replace(/\n/g, ' ').slice(0, 160) }).replace(/</g, '\\u003c')}\n</script>`
    : ''

  // determine OG image path
  const ogImagePath = ogImage || '/og/index.png'
  const ogImageUrl = `https://${site.domain}${ogImagePath}`

  return fill(layout, {
    title: escapeForHtml(title ? `${title} — ${site.name}` : site.name),
    portfolioNav: portfolioNavHtml,
    content,
    name: escapeForHtml(site.name),
    domain: escapeForHtml(site.domain),
    wallet: site.wallet || '',
    blogRegistry: site.network?.blogRegistryAddress || '',
    mediaRegistry: site.network?.mediaAddress || site.media?.contractAddress || '',
    registry: site.network?.registryAddress || '',
    supporter: site.supporter ? 'true' : '',
    description,
    ogTitle,
    ogImage: ogImageUrl,
    canonicalPath: canonicalPath || '/',
    noindex: noindex ? '<meta name="robots" content="noindex">' : '',
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

function out(path, html) {
  const dir = join(distDir, path)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
}

function sectionPage(heading, content, title, i18nKey, { description, noindex } = {}) {
  const headingKey = i18nKey || `nav.${heading}`
  // When a custom label is set (i18nKey is null), strip the data-i18n attribute
  // so the i18n runtime doesn't override the custom text
  let sectionHtml = sectionTpl
  if (!i18nKey) sectionHtml = sectionHtml.replace(/ data-i18n="[^"]*"/, '')
  const inner = fill(sectionHtml, { heading: title || heading, content, headingKey })
  const ogImage = `/og/${heading}.png`
  out(heading, wrap(inner, title || heading, `/${heading}`, ogImage, { description, noindex }))
}

function renderNetwork() {
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

function renderCollaborate() {
  const praxisAddr = site.network?.praxisAddress || ''
  const regAddr = site.network?.registryAddress || ''
  return `<div id="collab-data" data-hub="${praxisAddr}" data-registry="${regAddr}">
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

function renderLibrary() {
  const libAddr = site.network?.libraryRegistryAddress || ''
  return `<div id="library-data" data-address="${libAddr}">
<p id="library-status"><span class="praxis-loader"></span></p>
<div id="library-add-form" style="margin-bottom:2em"></div>
<div id="library-list"></div>
</div>`
}

// 1. build index

mkdirSync(distDir, { recursive: true })
const blogRegistryAddr = site.network?.blogRegistryAddress || ''

let indexContent
if (site.supporter) {
  // Supporter homepage: "my artists" + masonry collection grid + feed
  const topArtists = site.topArtists || []
  const slots = site.topArtistsSlots || 4

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
  <h1>${escapeForHtml(site.name)}</h1>
  <p class="bio">${escapeForHtml(site.bio || '')}</p>
  <div id="owner-badges"></div>
</header>

${myArtistsSection}

<div id="feed" data-blog="${blogRegistryAddr}" data-owner="${site.wallet || ''}" style="display:none">
  <p id="feed-status" style="color:var(--muted)"><span class="praxis-loader"></span></p>
  <div id="feed-posts"></div>
</div>

<div id="supporter-collection-section" data-wallet="${site.wallet || ''}">
  <p id="supporter-collection-status" style="color:var(--muted)"><span class="praxis-loader"></span></p>
  <div id="masonry-grid" class="masonry-grid"></div>
</div>`
} else {
  indexContent = fill(indexTpl, {
    name: escapeForHtml(site.name),
    bio: escapeForHtml(site.bio || ''),
    shortBio: escapeForHtml(site.shortBio || (site.bio && site.bio.length > 160 ? site.bio.slice(0, site.bio.lastIndexOf(' ', 160)) + '...' : site.bio || '')),
    highlights: buildHighlights(),
    cv: buildCV(),
    blogRegistry: blogRegistryAddr,
    wallet: site.wallet || '',
    representation: escapeForHtml(site.representation || ''),
    tagline: escapeForHtml(site.tagline || ''),
    reel: site.reel || '',
    profilePic: site.profilePic || '',
    profilePicTag: site.profilePic ? `<img class="header-pic" src="${escapeForHtml(site.profilePic)}" alt="" loading="lazy">` : '',
  })
}
writeFileSync(join(distDir, 'index.html'), wrap(indexContent, null, '/', '/og/index.png'))

// 2. build section pages

// module-based sections
for (const moduleEntry of getEnabledModules()) {
  const mod = MODULE_REGISTRY[moduleEntry.type]
  const content = mod.renderSection(moduleEntry.data)
  if (content) sectionPage(mod.route.slice(1), content, getTemplateLabel(moduleEntry.type, moduleEntry), moduleEntry.customLabel ? null : `module.${moduleEntry.type}`)
}

// network infrastructure sections (always built if in nav or modules format)
const networkSections = {
  projects: renderCollaborate(),
  library: renderLibrary(),
  network: renderNetwork(),
}

const networkDescriptions = {
  network: `discover artists on ${site.name}'s network. follow, connect, and collaborate.`,
  projects: `collaborative creative projects by ${site.name}. propose, fund, and build together.`,
  library: `shared knowledge base. PDFs, articles, and essays curated by ${site.name}.`,
}

for (const [name, content] of Object.entries(networkSections)) {
  sectionPage(name, content, undefined, undefined, { description: networkDescriptions[name] })
}

// journal page (always built, shown only to owner via JS)
const journalHtml = `<div id="journal-page">
<p id="journal-status" style="color:var(--muted)" data-i18n="journal.connectOwner"></p>
<div id="journal-content"></div>
</div>`
out('journal', wrap(journalHtml, 'journal', '/journal', '/og/index.png', { noindex: true }))

// collection page
const collectionHtml = `<div id="collection-page">
<p id="collection-status" style="color:var(--muted)"><span class="praxis-loader"></span></p>
<div id="collection-content"></div>
</div>`
out('collection', wrap(collectionHtml, 'collection', '/collection', '/og/collection.png', { description: `media and credentials collected by ${site.name}.` }))

// works for sale page
const worksHtml = `<div id="works-page">
<h2 data-i18n="works.title">works for sale</h2>
<p style="color:var(--dim);font-size:0.85em;max-width:50ch;margin:0.25em 0 1.5em;line-height:1.5">collect music, video, and art directly from the artist. 100% of every purchase goes to the creator. <a href="https://ourpraxis.network/how-it-works#soulbound" target="_blank" style="color:var(--accent)">learn more</a></p>
<p id="works-status" style="color:var(--muted)"><span class="praxis-loader"></span></p>
<div id="works-content"></div>
</div>`
out('works', wrap(worksHtml, 'works', '/works', '/og/index.png', { description: `works for sale by ${site.name}. music, video, art with collaborator splits.` }))

// organization page
const orgHtml = `<div id="org-page">
<span class="praxis-loader"></span>
</div>`
out('org', wrap(orgHtml, 'org', '/org', '/og/index.png', { description: `organizations on ${site.name}'s network.` }))

// art detail page (universal media/portfolio item viewer)
const artHtml = `<div id="art-page">
<div id="art-loading"><span class="praxis-loader"></span></div>
<div id="art-content"></div>
</div>`
out('art', wrap(artHtml, 'art', '/art', '/og/index.png'))

// vault page (also serves legacy /earnings route)
const vaultHtml = `<div id="vault-page" style="max-width:680px;margin:0 auto">
<h2 style="color:var(--fg)">vault</h2>
<div id="vault-content"><span class="praxis-loader"></span></div>
</div>`
out('vault', wrap(vaultHtml, 'vault', '/vault', '/og/index.png', { noindex: true }))
out('earnings', wrap(vaultHtml, 'vault', '/vault', '/og/index.png', { noindex: true }))

// cashout guide page
const cashoutHtml = `<div id="cashout-page" style="max-width:680px;margin:0 auto">
<h2>cash out</h2>
<div id="cashout-content"><span class="praxis-loader"></span></div>
</div>`
out('cashout', wrap(cashoutHtml, 'cash out', '/cashout', '/og/index.png', { noindex: true }))

// write page (full-page compose editor)
const writeHtml = `<div id="write-page">
<div class="write-inner">
  <div class="write-header">
    <button id="compose-close" class="write-back-btn" aria-label="back"><i class="ph ph-arrow-left"></i> <span style="font-size:0.55em;font-weight:normal;letter-spacing:0.1em;text-transform:uppercase;color:var(--border);margin-left:0.3ch">blog</span></button>
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
</div>`
out('write', wrap(writeHtml, 'write', '/write', '/og/index.png', { noindex: true }))

// notifications page
const notificationsHtml = `<div id="notifications-page" style="max-width:680px;margin:0 auto">
<h2 data-i18n="notifications.title">notifications</h2>
<div id="notifications-content"><span class="praxis-loader"></span></div>
</div>`
out('notifications', wrap(notificationsHtml, 'notifications', '/notifications', '/og/index.png', { noindex: true }))

// messages page (full page messaging)
const messagesHtml = `<div id="messages-page">
<div id="messages-container" class="messages-container">
  <div id="messages-sidebar" class="messages-sidebar">
    <div class="messages-sidebar-header" style="display:flex;align-items:center;justify-content:space-between">
      <span data-i18n="messages.title">messages</span>
      <div style="display:flex;align-items:center;gap:0.25em;margin-left:auto">
        <button id="messages-compose" style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0;font-family:inherit;display:inline-flex;align-items:center;justify-content:center"><i class="ph ph-plus-circle" style="font-size:1.2em"></i></button>
        <button id="messages-settings-btn" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center"><i class="ph ph-gear" style="font-size:1.2em"></i></button>
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
      <div id="messages-pay-bar" class="pay-bar-panel" style="display:none">
        <div class="pay-stepper-wrap" id="messages-pay-stepper">
          <button type="button" class="pay-step-btn" data-dir="minus">−</button>
          <div class="pay-amount-center"><span id="messages-pay-display" class="pay-display">$0</span></div>
          <button type="button" class="pay-step-btn" data-dir="plus">+</button>
        </div>
        <div class="pay-keypad-wrap" id="messages-pay-keypad">
          <input type="text" inputmode="decimal" id="messages-pay-eth-input" class="pay-eth-input" placeholder="0" autocomplete="off">
          <span class="pay-currency-label">ETH</span>
        </div>
        <span id="messages-pay-conversion" class="pay-conversion-line"></span>
        <button type="button" id="messages-pay-mode-toggle" class="pay-mode-toggle">Show Keypad</button>
        <span id="messages-pay-balance" class="pay-balance-line"></span>
        <div class="pay-actions">
          <button type="button" id="messages-pay-request" class="pay-action-btn pay-request-btn">Request</button>
          <button type="button" id="messages-pay-send" class="pay-action-btn pay-send-btn">Send</button>
        </div>
        <button type="button" id="messages-pay-cancel" class="pay-cancel-link">cancel</button>
      </div>
      <form id="messages-send-form" class="messages-send-form">
        <textarea id="messages-input" rows="1" placeholder="type a message..." autocomplete="off" data-i18n-placeholder="messages.placeholder" style="resize:none;overflow-y:hidden;min-height:1.8em;max-height:8em;line-height:1.4;border-radius:20px;padding:0.5em 1em"></textarea>
        <button type="button" id="messages-attach-btn" class="dock-btn" title="attach" style="font-size:1em"><i class="ph ph-paperclip"></i></button>
        <button type="button" id="messages-pay-toggle" class="dock-btn" title="send ETH" style="font-size:1em"><i class="ph ph-money"></i></button>
        <input type="file" id="messages-attach-input" accept="image/*,video/*,.pdf" style="display:none" multiple>
      </form>
    </div>
  </div>
</div>
</div>`
out('messages', wrap(messagesHtml, 'messages', '/messages', '/og/messages.png', { noindex: true }))

// project detail page (JS-rendered from Ponder)
const praxisAddr = site.network?.praxisAddress || ''
const regAddr = site.network?.registryAddress || ''
const projectDetailHtml = `
<div id="project-detail-page" data-praxis="${praxisAddr}" data-registry="${regAddr}" data-blog="${blogRegistryAddr}">
  <p id="project-detail-loading"><span class="praxis-loader"></span></p>
  <div id="project-detail-content"></div>
</div>`
out('project', wrap(projectDetailHtml, 'project', '/project', '/og/project.png', { description: 'creative project on praxis.' }))

// 3. build blog index (rendered by post.js)

const blogCollections = site.blogCollections || []
const blogPostCollections = site.blogPostCollections || {}
const blogCollectionsJson = JSON.stringify(blogCollections).replace(/</g, '\\u003c')
const blogPostCollectionsJson = JSON.stringify(blogPostCollections).replace(/</g, '\\u003c')

const blogIndexHtml = fill(blogIndexTpl, {})
// Inject collection data as a script block so post.js can read it
const blogDataScript = blogCollections.length > 0
  ? `<script>window.__blogCollections=${blogCollectionsJson};window.__blogPostCollections=${blogPostCollectionsJson};</script>`
  : ''
out('blog', wrap(blogDataScript + blogIndexHtml, 'blog', '/blog', '/og/blog.png', { description: `blog posts by ${site.name}.` }))

// Build per-collection blog pages (e.g. /blog/essays/)
for (const col of blogCollections) {
  const colSlug = col.slug || col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const colDataScript = `<script>window.__blogCollections=${blogCollectionsJson};window.__blogPostCollections=${blogPostCollectionsJson};window.__blogActiveCollection="${colSlug.replace(/"/g, '')}";</script>`
  const colHtml = `<section>
  <h1>${escapeForHtml(col.name)}</h1>
  ${col.description ? `<p style="color:var(--muted);margin-bottom:1.5em">${escapeForHtml(col.description)}</p>` : ''}
  <div id="blog-collection-filters"></div>
  <div id="onchain-posts"></div>
</section>`
  out(`blog/${colSlug}`, wrap(colDataScript + colHtml, col.name, `/blog/${colSlug}`, '/og/blog.png', { description: col.description || `${col.name} — blog posts by ${site.name}.` }))
}

// 4b. build post page (JS-rendered from Ponder)
const postPageHtml = `
<article id="post-page" data-blog="${blogRegistryAddr}">
  <p id="post-loading"><span class="praxis-loader"></span></p>
  <div id="post-content"></div>
</article>
`
out('post', wrap(postPageHtml, 'post', '/post', '/og/post.png', { description: `blog post by ${site.name}.` }))

// 5. build reading list

const readingFile = 'content/reading/list.json'
let readingItems = ''

if (existsSync(readingFile)) {
  const books = JSON.parse(readFileSync(readingFile, 'utf8'))
  readingItems = books
    .map(b => {
      const title = b.url ? `<a href="${b.url}" class="book-title">${b.title}</a>` : `<span class="book-title">${b.title}</span>`
      const note = b.note ? `<span class="book-note">${b.note}</span>` : ''
      return `<li>${title} <span class="book-author">— ${b.author}</span>${note}</li>`
    })
    .join('\n')
}

const readingHtml = fill(readingTpl, { items: readingItems })
out('reading', wrap(readingHtml, 'reading list', '/reading', '/og/index.png'))

// 6. generate OG images

// Always regenerate OG images — theme colors may have changed
await buildOgImages()

// 7. copy public assets

// In multi-tenant mode (DIST_DIR set), skip copying public/ to per-artist dirs (shared assets)
if (distDir === 'dist') {
  cpSync('public', distDir, { recursive: true })
} else {
  // Per-artist build: copy fresh CSS + JS (shared assets change frequently)
  try { cpSync('public/style.css', join(distDir, 'style.css')) } catch {}
  try { cpSync(join('public', 'js'), join(distDir, 'js'), { recursive: true }) } catch {}
}

// output public site.json for art detail page (modules data needed client-side)
// Always write — multi-tenant artists need their own site.json for art page to resolve aliases correctly
writeFileSync(join(distDir, 'site.json'), JSON.stringify(site))

// if template has its own style.css, copy it as template-style.css (loaded in addition to base)
const templateStylePath = join(templateDir, 'style.css')
if (existsSync(templateStylePath) && templateName !== 'default') {
  cpSync(templateStylePath, join(distDir, 'template-style.css'))
}

// 8. asset fingerprinting — hash JS/CSS referenced in HTML for long-lived cache headers

function collectHtmlFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) results.push(...collectHtmlFiles(full))
    else if (entry.name.endsWith('.html')) results.push(full)
  }
  return results
}

function fingerprintAssets() {
  const htmlFiles = collectHtmlFiles(distDir)
  const manifest = {}

  // regex to detect an existing 8-hex-char fingerprint in a filename: name.XXXXXXXX.ext
  const hashInNameRe = /\.[0-9a-f]{8}(?=\.\w+$)/

  // strip an existing fingerprint hash from a path, e.g. /js/foo.2cd8ff20.js -> /js/foo.js
  function stripHash(p) {
    return p.replace(hashInNameRe, '')
  }

  // clean up any previously fingerprinted files in dist/ (*.XXXXXXXX.js, *.XXXXXXXX.css)
  function cleanOldHashes(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        cleanOldHashes(full)
      } else if (hashInNameRe.test(entry.name) && /\.(js|css)(\.br|\.gz)?$/.test(entry.name)) {
        unlinkSync(full)
      }
    }
  }
  cleanOldHashes(distDir)

  // collect all asset references from HTML <script src="..."> and <link href="..."> tags
  const scriptRe = /<script[^>]+src="(\/js\/[^"]+\.js)"/g
  const linkRe = /<link[^>]+href="(\/[^"]+\.css)"/g
  const assetPaths = new Set()

  for (const htmlFile of htmlFiles) {
    const html = readFileSync(htmlFile, 'utf8')
    let m
    while ((m = scriptRe.exec(html)) !== null) assetPaths.add(stripHash(m[1]))
    scriptRe.lastIndex = 0
    while ((m = linkRe.exec(html)) !== null) {
      // skip external stylesheets (unpkg, etc.)
      if (!m[1].startsWith('/')) continue
      assetPaths.add(stripHash(m[1]))
    }
    linkRe.lastIndex = 0
  }

  // also normalize HTML references back to unhashed paths before we rewrite them
  for (const htmlFile of htmlFiles) {
    let html = readFileSync(htmlFile, 'utf8')
    // strip any leftover hashes from src/href attributes pointing to local assets
    html = html.replace(/((?:src|href)=")(\/[^"]*?)\.[0-9a-f]{8}(\.\w+")/g, '$1$2$3')
    writeFileSync(htmlFile, html)
  }

  // hash each asset and rename
  for (const assetPath of assetPaths) {
    const diskPath = join(distDir, assetPath.slice(1)) // remove leading /
    if (!existsSync(diskPath)) continue

    const content = readFileSync(diskPath)
    const hash = createHash('md5').update(content).digest('hex').slice(0, 8)
    const ext = extname(assetPath)
    const base = basename(assetPath, ext)
    const dir = assetPath.slice(0, assetPath.lastIndexOf('/'))
    const hashedName = `${base}.${hash}${ext}`
    const hashedPath = `${dir}/${hashedName}`
    const hashedDiskPath = join(distDir, hashedPath.slice(1))

    // copy file with hashed name (keep original for dynamic imports from other JS modules)
    cpSync(diskPath, hashedDiskPath)

    manifest[assetPath] = hashedPath
  }

  // update all HTML files to use hashed filenames
  // only replace exact attribute values (src="..." or href="...") to avoid corrupting CDN URLs
  for (const htmlFile of htmlFiles) {
    let html = readFileSync(htmlFile, 'utf8')
    for (const [original, hashed] of Object.entries(manifest)) {
      // escape for use in regex
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // replace only in src="..." and href="..." attribute values (exact match)
      html = html.replace(new RegExp(`((?:src|href)=")${escaped}(")`, 'g'), `$1${hashed}$2`)
    }
    writeFileSync(htmlFile, html)
  }

  // write manifest for server-side use
  writeFileSync(join(distDir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`fingerprinted ${Object.keys(manifest).length} assets`)
}

fingerprintAssets()

// 8b. pre-compress static files for serving

function preCompressFiles() {
  const compressible = ['.js', '.css', '.html', '.json', '.svg']
  let count = 0
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      const ext = extname(entry.name)
      if (!compressible.includes(ext)) continue
      const content = readFileSync(full)
      if (content.length < 1024) continue // skip tiny files
      writeFileSync(full + '.br', brotliCompressSync(content, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
      }))
      writeFileSync(full + '.gz', gzipSync(content, { level: 9 }))
      count++
    }
  }
  walk(distDir)
  console.log(`pre-compressed ${count} files (.br + .gz)`)
}

preCompressFiles()

// 9. generate robots.txt

const robotsTxt = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /journal
Disallow: /messages
Disallow: /vault
Disallow: /earnings
Disallow: /notifications
Disallow: /settings
Disallow: /collection

Sitemap: https://${site.domain}/sitemap.xml
`
writeFileSync(join(distDir, 'robots.txt'), robotsTxt)

// 10. generate sitemap.xml

const lastmod = new Date().toISOString().slice(0, 10)
const sitemapUrls = [`  <url><loc>https://${site.domain}/</loc><lastmod>${lastmod}</lastmod><priority>1.0</priority></url>`]
for (const moduleEntry of getEnabledModules()) {
  const mod = MODULE_REGISTRY[moduleEntry.type]
  sitemapUrls.push(`  <url><loc>https://${site.domain}${mod.route}</loc><lastmod>${lastmod}</lastmod><priority>0.8</priority></url>`)
}
for (const name of Object.keys(networkSections)) {
  sitemapUrls.push(`  <url><loc>https://${site.domain}/${name}</loc><lastmod>${lastmod}</lastmod><priority>0.7</priority></url>`)
}
sitemapUrls.push(`  <url><loc>https://${site.domain}/blog</loc><lastmod>${lastmod}</lastmod><priority>0.7</priority></url>`)

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.join('\n')}
</urlset>
`
writeFileSync(join(distDir, 'sitemap.xml'), sitemapXml)

// 11. generate manifest.json

const pwaName = site.pwa?.name || site.name
const pwaIcon = site.pwa?.icon || '/favicon.svg'
const manifestJson = {
  name: pwaName,
  short_name: pwaName,
  start_url: '/',
  display: 'standalone',
  background_color: site.pwa?.background || site.theme?.bg || '#0a0a0a',
  theme_color: site.theme?.bg || '#0a0a0a',
  icons: [
    ...(pwaIcon.endsWith('.svg') ? [{ src: pwaIcon, sizes: 'any', type: 'image/svg+xml' }] : []),
    ...(pwaIcon.endsWith('.png') ? [{ src: pwaIcon, sizes: '512x512', type: 'image/png' }] : []),
    ...(site.pwa?.icon192 ? [{ src: site.pwa.icon192, sizes: '192x192', type: 'image/png' }] : []),
    ...(!site.pwa?.icon ? [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }] : []),
  ]
}
writeFileSync(join(distDir, 'manifest.json'), JSON.stringify(manifestJson, null, 2))

// 12. copy service worker to dist (must be at root for scope)
try { cpSync(join(import.meta.dirname, 'public', 'sw.js'), join(distDir, 'sw.js')) } catch {}

console.log(`built ${getEnabledModules().length} modules + network pages (template: ${templateName})`)

// --- Phase 0.4: Build template shells for dynamic serve-time rendering ---
// When BUILD_TEMPLATES_ONLY=1, generate a "shell" for each template type
// with placeholder variables left in, so template-engine.js can inject
// site.json data at serve time instead of needing a per-artist build.

if (process.env.BUILD_TEMPLATES_ONLY === '1') {
  const TEMPLATE_TYPES = ['default', 'musician', 'visual', 'writer', 'performer', 'filmmaker', 'organization']
  const shellsDir = join(distDir, 'templates')
  mkdirSync(shellsDir, { recursive: true })

  for (const tplName of TEMPLATE_TYPES) {
    const tplDir = existsSync(`templates/${tplName}`) ? `templates/${tplName}` : 'templates/default'
    const shellDir = join(shellsDir, tplName)
    mkdirSync(shellDir, { recursive: true })

    // Copy raw template HTML files (with {{placeholders}} intact)
    const tplLayout = readFileSync(join(tplDir, 'layout.html'), 'utf8')
    const tplIndex = readFileSync(join(tplDir, 'index.html'), 'utf8')
    const tplSection = readFileSync(join(tplDir, 'section.html'), 'utf8')
    writeFileSync(join(shellDir, 'layout.html'), tplLayout)
    writeFileSync(join(shellDir, 'index.html'), tplIndex)
    writeFileSync(join(shellDir, 'section.html'), tplSection)

    // blog-index and reading templates (fall back to default)
    const tplBlogIndex = existsSync(join(tplDir, 'blog-index.html'))
      ? readFileSync(join(tplDir, 'blog-index.html'), 'utf8')
      : readFileSync('templates/default/blog-index.html', 'utf8')
    writeFileSync(join(shellDir, 'blog-index.html'), tplBlogIndex)

    const tplReading = existsSync(join(tplDir, 'reading.html'))
      ? readFileSync(join(tplDir, 'reading.html'), 'utf8')
      : readFileSync('templates/default/reading.html', 'utf8')
    writeFileSync(join(shellDir, 'reading.html'), tplReading)

    // Copy template-specific style.css if it exists
    const tplStylePath = join(tplDir, 'style.css')
    if (tplName !== 'default' && existsSync(tplStylePath)) {
      cpSync(tplStylePath, join(shellDir, 'style.css'))
    }

    // Write a per-template asset manifest referencing the shared fingerprinted assets
    // (the main dist/ asset-manifest.json applies to all templates since JS/CSS are shared)
    const mainManifestPath = join(distDir, 'asset-manifest.json')
    if (existsSync(mainManifestPath)) {
      cpSync(mainManifestPath, join(shellDir, 'asset-manifest.json'))
    }

    console.log(`  template shell: ${tplName} -> ${shellDir}`)
  }

  console.log(`built ${TEMPLATE_TYPES.length} template shells for dynamic serving`)
}
console.log(`done → ${distDir}/`)
