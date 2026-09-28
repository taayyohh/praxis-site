// Funding module — the one baked-in module for project sites.
// Renders a server-side shell (progress bar skeleton + fund button)
// that the client hydrates with live on-chain state from Praxis.sol.
//
// data: { projectId: number } — nothing else needed. All state
// (goal, raised, backers, deadline, tiers, status) comes from the
// contract at hydrate time. Poster art comes from `posterCid` on
// off-chain project_metadata if set.
import { esc } from './shared.js'

export default {
  type: 'funding',
  label: 'funding',
  route: '/funding',

  renderSection(data) {
    const pid = data?.projectId != null ? String(data.projectId) : ''
    if (!pid) return ''
    const posterCid = data?.posterCid ? String(data.posterCid) : ''
    const posterSrc = posterCid
      ? (posterCid.startsWith('ipfs://')
        ? `/api/ipfs/${posterCid.slice(7)}`
        : `/api/ipfs/${posterCid}`)
      : ''

    return `<div class="project-funding-widget" id="project-funding-anchor"
      data-project-id="${esc(pid)}"
      data-poster="${esc(posterSrc)}">
      <div class="funding-hero" ${posterSrc ? `style="background-image:url('${esc(posterSrc)}')"` : ''}>
        <div class="funding-hero-fade"></div>
        <div class="funding-hero-body">
          <div class="funding-status-pill" data-hydrate="status">loading</div>
          <h2 class="funding-title" data-hydrate="title">&nbsp;</h2>
          <p class="funding-blurb" data-hydrate="blurb"></p>
        </div>
      </div>

      <div class="funding-progress-wrap">
        <div class="funding-numbers">
          <span class="funding-raised" data-hydrate="raised">—</span>
          <span class="funding-of">of</span>
          <span class="funding-goal" data-hydrate="goal">—</span>
          <span class="funding-pct" data-hydrate="pct"></span>
        </div>
        <div class="funding-bar"><div class="funding-bar-fill" data-hydrate="bar" style="width:0%"></div></div>
        <div class="funding-meta">
          <span data-hydrate="backers">— backers</span>
          <span class="funding-meta-dot">·</span>
          <span data-hydrate="deadline">— left</span>
        </div>
      </div>

      <div class="funding-tiers" data-hydrate="tiers"></div>

      <div class="funding-cta-row">
        <button type="button" class="buy-btn funding-cta-btn" data-hydrate="cta" disabled>fund this project</button>
        <a class="funding-detail-link" href="/project?id=${esc(pid)}" data-hydrate="detail-link">view full detail →</a>
      </div>
      <p class="funding-action-status" data-hydrate="action-status" style="display:none"></p>
    </div>
    <script type="module">
      import('/js/funding-widget.js').then(m => m.initFundingWidget?.())
    </script>`
  },
}
