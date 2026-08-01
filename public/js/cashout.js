// Cash out guide — how to convert ETH on Optimism to local currency
import { registerPage } from './utils.js'
import { formatPriceWithFiat } from './fiat.js'

registerPage('cashout-page', initCashout)

async function initCashout() {
  const el = document.getElementById('cashout-content')
  if (!el) return

  el.innerHTML = `
    <div id="cashout-balance"></div>

    <div style="margin-bottom:2.5em">
      <h3 style="color:var(--fg);font-size:1em;margin:0 0 0.75em">how it works</h3>
      <p style="color:var(--dim);line-height:1.7;margin:0">
        your earnings are ETH on Optimism (an Ethereum layer 2). to get money in your bank account, you need to move it to an exchange, sell it, and withdraw. this usually takes 10-30 minutes.
      </p>
    </div>

    <div style="margin-bottom:2.5em">
      <h3 style="color:var(--fg);font-size:1em;margin:0 0 0.75em">step 1: bridge to an exchange</h3>
      <p style="color:var(--dim);line-height:1.7;margin:0 0 1em">
        send your ETH from Optimism to a cryptocurrency exchange that supports your country. most exchanges accept deposits directly on Optimism — just select "Optimism" as the network when generating a deposit address.
      </p>
      <p style="color:var(--dim);line-height:1.7;margin:0 0 1em">
        if your exchange doesn't support Optimism deposits, use the <a href="/network" style="color:var(--accent)">relay bridge</a> in your wallet menu to move ETH to Ethereum mainnet first, then deposit from there.
      </p>
    </div>

    <div style="margin-bottom:2.5em">
      <h3 style="color:var(--fg);font-size:1em;margin:0 0 0.75em">step 2: sell and withdraw</h3>
      <p style="color:var(--dim);line-height:1.7;margin:0 0 1em">
        once your ETH arrives at the exchange, sell it for your local currency (USD, EUR, GBP, NGN, KES, BRL, etc.) and withdraw to your bank account.
      </p>
    </div>

    <div style="margin-bottom:2.5em">
      <h3 style="color:var(--fg);font-size:1em;margin:0 0 0.75em">exchanges by region</h3>

      <div class="cashout-region">
        <div class="cashout-region-label">United States &amp; Canada</div>
        <div class="cashout-region-body">
          <strong>Coinbase</strong> — most popular, supports Optimism deposits, bank/ACH/wire withdrawal<br>
          <strong>Kraken</strong> — supports Optimism, bank/wire withdrawal<br>
          <strong>Cash App</strong> — buy/sell bitcoin, then transfer to bank (requires bridging ETH to BTC first)
        </div>
      </div>

      <div class="cashout-region">
        <div class="cashout-region-label">Europe &amp; UK</div>
        <div class="cashout-region-body">
          <strong>Coinbase</strong> — SEPA/FPS withdrawal<br>
          <strong>Kraken</strong> — SEPA/FPS withdrawal, supports Optimism<br>
          <strong>Bitstamp</strong> — SEPA withdrawal, EU-regulated
        </div>
      </div>

      <div class="cashout-region">
        <div class="cashout-region-label">Nigeria</div>
        <div class="cashout-region-body">
          <strong>Quidax</strong> — NGN withdrawal to Nigerian bank accounts<br>
          <strong>Luno</strong> — NGN withdrawal, established in Nigeria<br>
          <strong>Binance P2P</strong> — sell directly to local buyers for bank transfer
        </div>
      </div>

      <div class="cashout-region">
        <div class="cashout-region-label">Kenya &amp; East Africa</div>
        <div class="cashout-region-body">
          <strong>Binance P2P</strong> — KES withdrawal via M-Pesa or bank transfer<br>
          <strong>Paxful</strong> — P2P marketplace, M-Pesa support
        </div>
      </div>

      <div class="cashout-region">
        <div class="cashout-region-label">Brazil</div>
        <div class="cashout-region-body">
          <strong>Mercado Bitcoin</strong> — BRL withdrawal via PIX<br>
          <strong>Binance</strong> — BRL withdrawal via PIX or bank transfer<br>
          <strong>Foxbit</strong> — BRL withdrawal, Brazilian exchange
        </div>
      </div>

      <div class="cashout-region">
        <div class="cashout-region-label">India</div>
        <div class="cashout-region-body">
          <strong>WazirX</strong> — INR withdrawal to Indian bank account<br>
          <strong>CoinDCX</strong> — INR withdrawal, UPI support<br>
          <strong>Binance P2P</strong> — sell for INR via bank/UPI
        </div>
      </div>

      <div class="cashout-region">
        <div class="cashout-region-label">Japan &amp; South Korea</div>
        <div class="cashout-region-body">
          <strong>bitFlyer</strong> (Japan) — JPY withdrawal<br>
          <strong>Upbit</strong> (Korea) — KRW withdrawal<br>
          <strong>Bithumb</strong> (Korea) — KRW withdrawal
        </div>
      </div>

      <div class="cashout-region">
        <div class="cashout-region-label">rest of world</div>
        <div class="cashout-region-body">
          <strong>Binance</strong> — available in 100+ countries, P2P marketplace for local currency<br>
          <strong>Kraken</strong> — available in most countries, bank withdrawal<br>
          <strong>OKX</strong> — wide country support, P2P option
        </div>
      </div>
    </div>

    <div style="margin-bottom:2.5em">
      <h3 style="color:var(--fg);font-size:1em;margin:0 0 0.75em">using your embedded wallet</h3>
      <p style="color:var(--dim);line-height:1.7;margin:0 0 1em">
        if you're using the built-in Praxis wallet, you'll need to export your private key to send funds to an exchange. go to <strong>settings → account → export key</strong>, then import that key into a wallet app like MetaMask or Rainbow to send the deposit.
      </p>
      <p style="color:var(--dim);line-height:1.7;margin:0">
        if you connected an external wallet (MetaMask, Rainbow, etc.), you can send directly from that wallet to your exchange deposit address.
      </p>
    </div>

    <div style="margin-bottom:2.5em">
      <h3 style="color:var(--fg);font-size:1em;margin:0 0 0.75em">tips</h3>
      <ul style="color:var(--dim);line-height:1.9;padding-left:1.5em;margin:0">
        <li>always double-check the deposit network — select <strong>Optimism</strong> (not Ethereum mainnet) to avoid lost funds</li>
        <li>start with a small test transfer before sending large amounts</li>
        <li>gas fees on Optimism are typically under $0.01</li>
        <li>exchange withdrawal times vary: ACH 1-3 days, SEPA 1-2 days, wire same day, M-Pesa instant</li>
      </ul>
    </div>
  `

  const addr = window.getWalletAddress?.()
  if (addr) {
    try {
      const { getPublicClient } = await import('./utils.js')
      const pc = await getPublicClient()
      const bal = await pc.getBalance({ address: addr })
      const fiatStr = await formatPriceWithFiat(bal)
      const balEl = document.getElementById('cashout-balance')
      if (balEl) {
        balEl.innerHTML = `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1.5em;margin-bottom:2em">
            <div style="color:var(--dim);font-size:0.85em;margin-bottom:0.5em">your balance on Optimism</div>
            <div style="font-size:1.4em;color:var(--fg)">${fiatStr}</div>
          </div>
        `
      }
    } catch {}
  }
}
