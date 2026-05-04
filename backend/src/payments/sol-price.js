// @ts-check
// SOL/USD price oracle — fetches current price from CoinGecko public API.
// Used for margin tracking and SOL-denominated order quotes.

const CACHE_TTL_MS = 30_000;
let _cache = { price: null, at: 0 };

async function getSolUsdPrice() {
  const now = Date.now();
  if (_cache.price !== null && now - _cache.at < CACHE_TTL_MS) {
    return _cache.price;
  }

  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    { signal: AbortSignal.timeout(5000) },
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);

  const body = await res.json();
  const price = body?.solana?.usd;
  if (typeof price !== 'number' || price <= 0) throw new Error('invalid price response');

  _cache = { price, at: now };
  return price;
}

/**
 * Convert a USD amount to SOL at current market price.
 * @param {number} usdAmount
 * @returns {Promise<string>} SOL amount as decimal string (9 dp)
 */
async function usdToSol(usdAmount) {
  const price = await getSolUsdPrice();
  const sol = usdAmount / price;
  return sol.toFixed(9);
}

module.exports = { getSolUsdPrice, usdToSol };
