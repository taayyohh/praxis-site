// gallery-ui.js — lightbox and interactive gallery handlers
// Loaded as a route module via spa.js — uses document-level event delegation
// so it works after SPA navigation without re-init

const _lb = { el: null, idx: 0, keyHandler: null }

function _getThumbs() {
  return Array.from(document.querySelectorAll('.gallery-thumb'))
}

function _lbClose() {
  if (_lb.el) { _lb.el.remove(); _lb.el = null }
  document.body.style.overflow = ''
  if (_lb.keyHandler) { document.removeEventListener('keydown', _lb.keyHandler); _lb.keyHandler = null }
}

function _lbShow(index) {
  const thumbs = _getThumbs()
  if (!thumbs.length) return
  _lb.idx = ((index % thumbs.length) + thumbs.length) % thumbs.length
  const t = thumbs[_lb.idx]
  const src = t.dataset.full || t.src
  const caption = t.dataset.caption || ''
  const artUrl = t.dataset.artUrl || ''
  const capHtml = escapeHtml(caption) + (artUrl ? ` <a href="${escapeAttr(artUrl)}" style="color:rgba(255,255,255,0.5);margin-left:1ch;font-size:0.9em" onclick="event.stopPropagation()">view page</a>` : '')

  if (!_lb.el) {
    const el = document.createElement('div')
    el.className = 'gallery-lightbox'
    el.innerHTML = '<button class="gallery-lightbox-close" aria-label="close">&times;</button><img alt=""><div class="gallery-lightbox-caption"></div>'
    document.body.appendChild(el)
    document.body.style.overflow = 'hidden'
    _lb.el = el

    el.addEventListener('click', (e) => { if (e.target === el) _lbClose() })
    el.querySelector('.gallery-lightbox-close').addEventListener('click', _lbClose)

    _lb.keyHandler = (e) => {
      if (!_lb.el) return
      if (e.key === 'Escape') _lbClose()
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); _lbShow(_lb.idx + 1) }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); _lbShow(_lb.idx - 1) }
    }
    document.addEventListener('keydown', _lb.keyHandler)
  }

  _lb.el.querySelector('img').src = src
  _lb.el.querySelector('img').alt = caption
  _lb.el.querySelector('.gallery-lightbox-caption').innerHTML = capHtml
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function escapeAttr(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Single document-level handler — survives SPA innerHTML swaps
let _clickBound = false
function _bindClick() {
  if (_clickBound) return
  _clickBound = true
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.gallery-thumb')
    if (!img) return
    e.preventDefault()
    // Close any open lightbox first (cleans up old keyHandler)
    if (_lb.el) _lbClose()
    _lbShow(_getThumbs().indexOf(img))
  })
}

// Close lightbox on SPA navigation away from gallery
window.addEventListener('spa-navigate', () => {
  if (_lb.el) _lbClose()
})

_bindClick()
