// Balance + price lookups for scanned wallets.
//
// Runs on the Lambda (which has outbound internet). In local/dev it can fall back
// to a MOCK so the UI is demonstrable without network access. Every call is
// wrapped so a failed chain/price lookup degrades to { error } instead of
// breaking the whole scan.
//
// Native balances: BTC (Blockstream), EVM (eth_getBalance), TRX (TronGrid).
// Token balances (ERC-20 / BEP-20): eth_call balanceOf on the token contract.
import { NETWORK_IDS } from './networks.mjs';

const MOCK = process.env.MOCK_BALANCES === '1' || (process.env.STORE_MODE !== 'aws' && process.env.MOCK_BALANCES !== '0');

// Which networks we can fetch balances for, how, and which tokens to include.
export const BALANCE_CONFIG = {
  ethereum: {
    kind: 'evm', rpc: 'https://eth.llamarpc.com', symbol: 'ETH', coingecko: 'ethereum', decimals: 18,
    tokens: [
      { symbol: 'USDT', contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, coingecko: 'tether' },
      { symbol: 'USDC', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, coingecko: 'usd-coin' },
      { symbol: 'BUSD', contract: '0x4Fabb145d64652a948d72533023f6E7A623C7C53', decimals: 18, coingecko: 'binance-usd' },
      { symbol: 'DAI', contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, coingecko: 'dai' },
    ],
  },
  bnb: {
    kind: 'evm', rpc: 'https://binance.llamarpc.com', symbol: 'BNB', coingecko: 'binancecoin', decimals: 18,
    tokens: [
      { symbol: 'BUSD', contract: '0xe9e7CEA3DedcA5984780Bafc599bE2b0F8CAa7c8', decimals: 18, coingecko: 'binance-usd' },
      { symbol: 'USDT', contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, coingecko: 'tether' },
      { symbol: 'USDC', contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, coingecko: 'usd-coin' },
    ],
  },
  bitcoin: { kind: 'btc', symbol: 'BTC', coingecko: 'bitcoin', decimals: 8 },
  bitcoinLegacy: { kind: 'btc', symbol: 'BTC', coingecko: 'bitcoin', decimals: 8 },
  bitcoinNested: { kind: 'btc', symbol: 'BTC', coingecko: 'bitcoin', decimals: 8 },
  bitcoinTaproot: { kind: 'btc', symbol: 'BTC', coingecko: 'bitcoin', decimals: 8 },
  tron: {
    kind: 'tron', symbol: 'TRX', coingecko: 'tron', decimals: 6,
    tokens: [
      { symbol: 'USDT', contract: 'TR7NHqjeKQxwQ12brMJFCGmNTw4UcoVjc6', decimals: 6, coingecko: 'tether' },
      { symbol: 'USDC', contract: 'TEkxiTehnzSCVEmWn4KkvXmsiT9c4PXhET', decimals: 6, coingecko: 'usd-coin' },
    ],
  },
  // bnbBeacon is legacy BEP2 without a reliable keyless API; reported as unavailable.
  bnbBeacon: { kind: 'skip', symbol: 'BNB' },
};

const COINGECKO_IDS = [...new Set(Object.values(BALANCE_CONFIG).flatMap((c) => [c.coingecko, ...(c.tokens || []).map((t) => t.coingecko)]).filter(Boolean))];

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 8000));
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function evmBalance(rpc, address) {
  const data = await fetchJson(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  });
  if (!data.result) throw new Error('no result');
  return Number(BigInt(data.result)) / 1e18;
}

// ERC-20/BEP-20 balanceOf(address) via eth_call.
async function evmTokenBalance(rpc, contract, address, decimals) {
  const data = '0x70a08231' + '0'.repeat(24) + address.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  const res = await fetchJson(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }),
  });
  if (!res.result) throw new Error('no result');
  return Number(BigInt(res.result)) / 10 ** decimals;
}

async function btcBalance(address) {
  const data = await fetchJson(`https://blockstream.info/api/address/${address}`);
  const funded = BigInt(data.chain_stats.funded_txo_sum || 0);
  const spent = BigInt(data.chain_stats.spent_txo_sum || 0);
  return Number(funded - spent) / 1e8;
}

async function tronBalance(address) {
  const data = await fetchJson(`https://api.trongrid.io/v1/accounts/${address}`);
  const acct = data?.data?.[0];
  if (!acct) return 0;
  return Number(acct.balance || 0) / 1e6;
}

// TRC-20 token balance via TronGrid account-tokens list (matched by contract).
async function tronTokenBalance(address, token) {
  const data = await fetchJson(`https://api.trongrid.io/v1/accounts/${address}/tokens`);
  const held = data?.data || [];
  const found = held.find((h) => (h.tokenId || '').toLowerCase() === token.contract.toLowerCase());
  if (!found) return 0; // token not held by this address
  const raw = BigInt(found.balance || '0');
  return Number(raw) / 10 ** Number(found.tokenDecimal || token.decimals);
}

export async function getPrices() {
  if (MOCK) {
    return { bitcoin: 60000, ethereum: 2500, binancecoin: 500, tron: 0.12, tether: 1, 'usd-coin': 1, 'binance-usd': 1, dai: 1 };
  }
  try {
    const ids = COINGECKO_IDS.join(',');
    const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
    const out = {};
    for (const id of COINGECKO_IDS) out[id] = data?.[id]?.usd ?? 0;
    return out;
  } catch {
    return {};
  }
}

// addresses: { networkId: address }
// Returns { balances: { networkId: {symbol, balance, valueUsd, error, tokens?} }, totalValueUsd, mocked }
export async function getWalletBalances(addresses, prices) {
  const priceMap = prices || (await getPrices());
  const balances = {};
  let totalValueUsd = 0;
  let mocked = false;

  for (const id of NETWORK_IDS) {
    const cfg = BALANCE_CONFIG[id];
    const address = addresses?.[id];
    if (!cfg || !address || cfg.kind === 'skip') {
      if (cfg?.kind === 'skip') balances[id] = { symbol: cfg.symbol, balance: 0, valueUsd: 0, error: 'legacy network (no keyless API)' };
      continue;
    }
    const seedNum = Number(`0x${address.replace(/[^0-9a-f]/gi, '').slice(-8) || '0'}`) || 0;
    try {
      let balance;
      if (MOCK) {
        mocked = true;
        const frac = (seedNum % 1000) / 1000;
        balance = id.startsWith('bitcoin') ? (frac * 2).toFixed(6) : frac * (id === 'tron' ? 9000 : 12);
        if (seedNum % 7 === 0) balance = 0; // some wallets are empty -> filtered out
      } else if (cfg.kind === 'evm') {
        balance = await evmBalance(cfg.rpc, address);
      } else if (cfg.kind === 'btc') {
        balance = await btcBalance(address);
      } else if (cfg.kind === 'tron') {
        balance = await tronBalance(address);
      }
      const price = priceMap[cfg.coingecko] || 0;
      const valueUsd = Number(balance) * price;
      totalValueUsd += valueUsd;
      const entry = { symbol: cfg.symbol, balance: Number(balance), valueUsd, error: null };

      if (cfg.tokens?.length) {
        const tokens = [];
        for (const tk of cfg.tokens) {
          try {
            let tokBal;
            if (MOCK) {
              tokBal = seedNum % 11 === 0 ? 0 : (seedNum % 500) / 100 * 1000; // 0..~5000 units
            } else if (cfg.kind === 'evm') {
              tokBal = await evmTokenBalance(cfg.rpc, tk.contract, address, tk.decimals);
            } else if (cfg.kind === 'tron') {
              tokBal = await tronTokenBalance(address, tk);
            } else {
              throw new Error('unsupported token chain');
            }
            const tokPrice = priceMap[tk.coingecko] || 0;
            const tokValue = Number(tokBal) * tokPrice;
            totalValueUsd += tokValue;
            tokens.push({ symbol: tk.symbol, balance: Number(tokBal), valueUsd: tokValue, error: null });
          } catch (err) {
            tokens.push({ symbol: tk.symbol, balance: 0, valueUsd: 0, error: err.message || 'unavailable' });
          }
        }
        entry.tokens = tokens;
      }
      balances[id] = entry;
    } catch (err) {
      balances[id] = { symbol: cfg.symbol, balance: 0, valueUsd: 0, error: err.message || 'unavailable' };
    }
  }
  return { balances, totalValueUsd, mocked };
}
