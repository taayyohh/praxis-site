# praxis-site

Self-hostable artist site for the [Praxis network](https://ourpraxis.network).

## Quick start

```bash
npm install
# edit site.json with your info
node build.js
node server.js
```

Your site will be running at http://localhost:3000

## What's included

- Full artist site with 6 templates (default, musician, visual, writer, performer, filmmaker)
- Blog with on-chain publishing
- Private encrypted journal with screenplay/stage play editor
- Media marketplace (sell music, video, art — 100% to you)
- Project funding tools with credential system
- Encrypted messaging via XMTP
- Network feed, graph, and discovery
- Persistent audio player
- 20 language translations
- Embedded wallet (no MetaMask required)

## Configuration

Edit `site.json` to configure your site:

```json
{
  "handle": "yourhandle",
  "domain": "yourdomain.com",
  "wallet": "0x...",
  "name": "Your Name",
  "bio": "your bio",
  "template": "default"
}
```

Then rebuild: `node build.js`

## Environment variables

- `PORT` — server port (default: 3000)
- `PONDER_URL` — Ponder indexer (default: https://ourpraxis.network/ponder)
- `IPFS_GATEWAY` — IPFS gateway (default: https://ourpraxis.network/ipfs)

## License

MIT — your data, your site, your rules.
