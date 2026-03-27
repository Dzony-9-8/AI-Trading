/**
 * Crypto news sentiment via CryptoPanic public API.
 * No API key required for basic public feed.
 * Results cached for 15 minutes to avoid hammering the endpoint.
 */

import * as https from 'https';
import { log } from '../logger';

export interface NewsSentiment {
  score: number;       // -1.0 (very bearish) to +1.0 (very bullish)
  label: 'bullish' | 'neutral' | 'bearish';
  headlines: string[]; // Top 3 recent headlines for this currency
}

interface CryptoPanicPost {
  title: string;
  currencies?: { code: string }[];
  votes?: { positive: number; negative: number; important: number; liked: number; disliked: number; lol: number; toxic: number; saved: number; comments: number };
}

interface CryptoPanicResponse {
  results?: CryptoPanicPost[];
}

// 15-minute cache per currency
const cache = new Map<string, { data: NewsSentiment; expiresAt: number }>();

// Symbol → currency code mapping (CryptoPanic uses codes like BTC, ETH, SOL)
function symbolToCurrency(symbol: string): string {
  return symbol.split('/')[0].toUpperCase();
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Fetch and score recent news sentiment for a given trading symbol.
 * Returns neutral sentiment on any failure — never blocks trading.
 */
export async function getNewsSentiment(symbol: string): Promise<NewsSentiment> {
  const currency = symbolToCurrency(symbol);
  const cacheKey = currency;
  const now = Date.now();

  // Return cached result if still fresh
  const cached = cache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    return cached.data;
  }

  try {
    const url = `https://cryptopanic.com/api/v1/posts/?public=true&currencies=${currency}&kind=news`;
    const body = await httpGet(url);
    const data: CryptoPanicResponse = JSON.parse(body);

    if (!data.results || data.results.length === 0) {
      return neutral(currency);
    }

    // Score based on vote ratios across most recent 20 posts
    const posts = data.results.slice(0, 20);
    let totalPositive = 0;
    let totalNegative = 0;
    const headlines: string[] = [];

    for (const post of posts) {
      if (headlines.length < 3) headlines.push(post.title);
      const v = post.votes;
      if (v) {
        totalPositive += (v.positive ?? 0) + (v.liked ?? 0);
        totalNegative += (v.negative ?? 0) + (v.disliked ?? 0) + (v.toxic ?? 0);
      }
    }

    const total = totalPositive + totalNegative;
    let score = 0;
    if (total > 0) {
      score = (totalPositive - totalNegative) / total;
      // Clamp to [-1, 1]
      score = Math.max(-1, Math.min(1, score));
    }

    const label: NewsSentiment['label'] =
      score > 0.15 ? 'bullish' :
      score < -0.15 ? 'bearish' :
      'neutral';

    const result: NewsSentiment = { score: parseFloat(score.toFixed(3)), label, headlines };

    // Cache for 15 minutes
    cache.set(cacheKey, { data: result, expiresAt: now + 15 * 60 * 1000 });

    log.debug(`[${symbol}] news sentiment`, { score: result.score, label: result.label });
    return result;

  } catch (e) {
    log.debug(`[${symbol}] news sentiment fetch failed — using neutral`, { error: (e as Error).message });
    return neutral(currency);
  }
}

/**
 * Convert sentiment score to a position size multiplier.
 * - Bearish news → reduce size
 * - Bullish news → slight increase (capped at 1.2×)
 * - Neutral → no change
 */
export function sentimentSizeMultiplier(sentiment: NewsSentiment): number {
  if (sentiment.score < -0.4) return 0.5;   // Very bearish → half size
  if (sentiment.score < -0.2) return 0.7;   // Bearish → 70%
  if (sentiment.score > 0.4)  return 1.2;   // Very bullish → 120%
  if (sentiment.score > 0.2)  return 1.1;   // Bullish → 110%
  return 1.0;                                // Neutral → no change
}

function neutral(currency: string): NewsSentiment {
  const n: NewsSentiment = { score: 0, label: 'neutral', headlines: [] };
  cache.set(currency, { data: n, expiresAt: Date.now() + 5 * 60 * 1000 }); // cache neutral for 5 min
  return n;
}
