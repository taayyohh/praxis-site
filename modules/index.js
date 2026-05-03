// Module registry — all available content modules
import music from './music.js'
import audio from './audio.js'
import credits from './credits.js'
import gallery from './gallery.js'
import writing from './writing.js'
import film from './film.js'
import technology from './technology.js'
import education from './education.js'
import video from './video.js'
import demos from './demos.js'

export const MODULE_REGISTRY = {
  music,
  audio,
  credits,
  gallery,
  writing,
  film,
  video,
  technology,
  education,
  demos,
}

// legacy type mapping — old site.json keys → module types
export const LEGACY_TYPE_MAP = {
  music: 'music',
  theater: 'credits',   // theater credits → universal credits
  film: 'credits',       // film credits → universal credits (with category tag)
  tv: 'credits',         // tv credits → universal credits
  engineering: 'technology',
  portfolio: 'technology', // generic portfolio → technology
}

export default MODULE_REGISTRY
