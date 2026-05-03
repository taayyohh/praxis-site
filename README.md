# praxis-site

Self-hostable artist site for the [Praxis network](https://ourpraxis.network).

## Quick start (from scratch)

```bash
git clone https://github.com/taayyohh/praxis-site.git my-site
cd my-site
npm install
# edit site.json with your info
node build.js
node server.js
```

Your site will be running at http://localhost:3000

## Quick start (exported from praxis)

If you exported your site from **settings → export site** on your praxis site:

```bash
tar xzf praxis-yourhandle.tar.gz
cd praxis-yourhandle
npm install
node build.js
node server.js
```

Your exported site includes your site.json, blog content, and all configuration — ready to run.

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

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `PONDER_URL` | `https://ourpraxis.network/ponder` | Ponder indexer for on-chain data |
| `IPFS_GATEWAY` | `https://ourpraxis.network/ipfs` | IPFS gateway for media |

## What's included

- Full artist site with 6 templates (default, musician, visual, writer, performer, filmmaker)
- Blog with on-chain publishing
- Private encrypted journal with screenplay/stage play editor
- Media marketplace — sell music, video, art (100% to you)
- Project funding tools with credential system
- Encrypted messaging via XMTP
- Network feed, graph, and discovery
- Persistent audio player
- 20 language translations
- Embedded wallet (no MetaMask required)

## What's on-chain

Your identity, followers, blog posts, credentials, and media listings live on the Optimism blockchain. They're permanent and don't depend on any server. This site is just a window into your on-chain data.

## Deploying

Any Node.js host works. Some options:

```bash
# with pm2
npm install -g pm2
node build.js
pm2 start server.js --name my-site

# with docker
docker build -t my-site .
docker run -p 3000:3000 my-site

# or just
PORT=3000 node server.js
```

Point your domain's DNS to your server. The site handles everything else.

## License

MIT — your data, your site, your rules.
