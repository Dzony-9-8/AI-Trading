/**
 * Multi-agent AI system inspired by claude_prophet.
 * Three specialized agents that run when CLAUDE_API_KEY is set.
 * All agents fall back to rules-only (return null) if AI is unavailable.
 *
 * - StrategyAgent  → validates setup before entry (wraps confirmSignal in claude.ts)
 * - RiskAgent      → reviews position sizing, can reduce but not increase beyond Kelly max
 * - PostmortemAgent→ classifies closed trades and extracts lessons
 */

import Anthropic from '@anthropic-ai/sdk';
import { log } from '../logger';
import { getDb } from '../data/db';
import { recordAiSpend, getAiSpendToday } from '../core/state';
import { recordAiCost } from '../survival/economics';
import { selectModel, estimateCost } from './model-selector';
import { getConfig } from '../config';

let _client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!process.env.CLAUDE_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _client;
}

// ─── Strategy Agent ──────────────────────────────────────────────────────────

export interface StrategyDecision {
  approve: boolean;
  confidence: number; // 0–1
  reasoning: string;
}

/**
 * Validate a rule-based entry signal before execution.
 * Returns null if AI unavailable (bot proceeds on rules alone).
 */
export async function strategyAgent(params: {
  symbol: string;
  strategy: string;
  action: string;
  ruleReasoning: string;
  indicators: {
    rsi: number | null;
    macd: number | null;
    bb_upper: number | null;
    bb_lower: number | null;
    atr: number | null;
    sma50: number | null;
    sma200: number | null;
  };
  newsSentiment: { label: string; score: number };
  balance: number;
  tier: string;
}): Promise<StrategyDecision | null> {
  const client = getClient();
  if (!client) return null;

  const { max_daily_spend_usd } = getConfig().ai;
  if (getAiSpendToday() >= max_daily_spend_usd) {
    log.debug('StrategyAgent: daily AI budget exhausted — skipping', {
      spentUsd: getAiSpendToday().toFixed(4),
      capUsd: max_daily_spend_usd,
    });
    return null;
  }

  const model = selectModel();

  const prompt = `You are a trading strategy validator for a crypto bot.

Symbol: ${params.symbol}
Strategy: ${params.strategy}
Proposed action: ${params.action}
Rule engine reasoning: ${params.ruleReasoning}

Technical indicators:
- RSI(14): ${params.indicators.rsi?.toFixed(1) ?? 'N/A'}
- MACD: ${params.indicators.macd?.toFixed(4) ?? 'N/A'}
- BB Upper/Lower: ${params.indicators.bb_upper?.toFixed(2) ?? 'N/A'} / ${params.indicators.bb_lower?.toFixed(2) ?? 'N/A'}
- ATR: ${params.indicators.atr?.toFixed(4) ?? 'N/A'}
- SMA50: ${params.indicators.sma50?.toFixed(2) ?? 'N/A'}
- SMA200: ${params.indicators.sma200?.toFixed(2) ?? 'N/A'}

News sentiment: ${params.newsSentiment.label} (score: ${params.newsSentiment.score})
Account: $${params.balance.toFixed(2)} | Tier: ${params.tier}

Validate this setup. Be conservative — only approve high-conviction setups.
Respond with JSON only: {"approve": true|false, "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
      system: 'You are a conservative crypto trading strategy validator. Respond only with valid JSON.',
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    const cost = estimateCost(model, response.usage.input_tokens, response.usage.output_tokens);
    recordAiSpend(cost);
    recordAiCost(cost);

    const parsed = JSON.parse(text) as StrategyDecision;
    log.debug('StrategyAgent decision', { symbol: params.symbol, approve: parsed.approve, confidence: parsed.confidence, costUsd: cost.toFixed(5) });
    return parsed;
  } catch (e) {
    log.debug('StrategyAgent failed — rules-only', { error: (e as Error).message });
    return null;
  }
}

// ─── Risk Agent ───────────────────────────────────────────────────────────────

export interface RiskDecision {
  approve: boolean;
  adjustedRiskPct: number; // e.g. 0.02 for 2% — can only reduce, never increase
  reasoning: string;
}

/**
 * Review proposed position sizing before placing the order.
 * Can reduce risk percentage but cannot increase it beyond the proposed amount.
 */
export async function riskAgent(params: {
  symbol: string;
  proposedRiskPct: number;  // e.g. 0.02 = 2%
  currentDrawdownPct: number;
  openPositionsCount: number;
  regime: string;
  fearGreedValue: number | null;
  balance: number;
}): Promise<RiskDecision | null> {
  const client = getClient();
  if (!client) return null;

  const { max_daily_spend_usd } = getConfig().ai;
  if (getAiSpendToday() >= max_daily_spend_usd) {
    log.debug('RiskAgent: daily AI budget exhausted — skipping', {
      spentUsd: getAiSpendToday().toFixed(4),
      capUsd: max_daily_spend_usd,
    });
    return null;
  }

  const model = selectModel();

  const prompt = `You are a risk management agent for a crypto trading bot.

Proposed trade: ${params.symbol}
Proposed risk: ${(params.proposedRiskPct * 100).toFixed(1)}% of account
Current drawdown: ${(params.currentDrawdownPct * 100).toFixed(1)}%
Open positions: ${params.openPositionsCount}
Market regime: ${params.regime}
Fear & Greed index: ${params.fearGreedValue ?? 'unavailable'}
Account balance: $${params.balance.toFixed(2)}

Should this trade proceed? You may reduce risk but CANNOT increase it above ${(params.proposedRiskPct * 100).toFixed(1)}%.
Respond with JSON only: {"approve": true|false, "adjustedRiskPct": 0.00-${params.proposedRiskPct.toFixed(3)}, "reasoning": "brief explanation"}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
      system: 'You are a conservative crypto risk manager. Respond only with valid JSON.',
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    const cost = estimateCost(model, response.usage.input_tokens, response.usage.output_tokens);
    recordAiSpend(cost);
    recordAiCost(cost);

    const parsed = JSON.parse(text) as RiskDecision;
    // Safety: never allow risk agent to increase above proposed
    parsed.adjustedRiskPct = Math.min(parsed.adjustedRiskPct, params.proposedRiskPct);
    log.debug('RiskAgent decision', { symbol: params.symbol, approve: parsed.approve, risk: parsed.adjustedRiskPct, costUsd: cost.toFixed(5) });
    return parsed;
  } catch (e) {
    log.debug('RiskAgent failed — rules-only', { error: (e as Error).message });
    return null;
  }
}

// ─── Postmortem Agent ─────────────────────────────────────────────────────────

export type PostmortemClassification =
  | 'TRUE_POSITIVE'
  | 'FALSE_POSITIVE'
  | 'REGIME_MISMATCH'
  | 'EARLY_EXIT'
  | 'CORRECT_EXIT';

export interface PostmortemResult {
  classification: PostmortemClassification;
  lesson: string;
  patternTag: string; // e.g. "RSI_DIVERGENCE", "MACD_FAKEOUT", "CLEAN_BREAKOUT"
}

/**
 * Classify a closed trade and extract a lesson.
 * Uses Sonnet for large trades (>5% balance impact), Haiku for routine ones.
 */
export async function postmortemAgent(params: {
  symbol: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  holdingHours: number;
  action: string;          // stop_loss | take_profit | sell | strategy_exit
  entryRsi: number | null;
  entryMacd: number | null;
  balance: number;
}): Promise<PostmortemResult | null> {
  const client = getClient();
  if (!client) return null;

  const { max_daily_spend_usd } = getConfig().ai;
  if (getAiSpendToday() >= max_daily_spend_usd) {
    log.debug('PostmortemAgent: daily AI budget exhausted — skipping', {
      spentUsd: getAiSpendToday().toFixed(4),
      capUsd: max_daily_spend_usd,
    });
    return null;
  }

  // Escalate to Sonnet for large trades (>3% balance impact)
  const impactPct = Math.abs(params.pnl) / params.balance;
  const model = impactPct > 0.03 ? 'claude-sonnet-4-6' : selectModel();

  const pnlStr = `${params.pnl >= 0 ? '+' : ''}$${params.pnl.toFixed(2)} (${params.pnl >= 0 ? '+' : ''}${(params.pnl / params.balance * 100).toFixed(2)}%)`;

  const prompt = `Analyse this closed crypto trade and classify it.

Symbol: ${params.symbol} | Strategy: ${params.strategy}
Entry: $${params.entryPrice.toFixed(2)} → Exit: $${params.exitPrice.toFixed(2)}
P&L: ${pnlStr} | Hold time: ${params.holdingHours.toFixed(1)}h
Exit reason: ${params.action}
RSI at entry: ${params.entryRsi?.toFixed(1) ?? 'N/A'}
MACD at entry: ${params.entryMacd?.toFixed(4) ?? 'N/A'}

Classify as one of: TRUE_POSITIVE (good entry, good exit), FALSE_POSITIVE (bad entry), REGIME_MISMATCH (right signal, wrong market), EARLY_EXIT (left money on table), CORRECT_EXIT (right to exit when we did).
Extract one actionable lesson and one pattern tag (e.g. RSI_DIVERGENCE, MACD_FAKEOUT, VOLUME_SPIKE, CLEAN_BREAKOUT, DISTRIBUTION_TRAP).

Respond with JSON only: {"classification": "...", "lesson": "...", "patternTag": "..."}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
      system: 'You are a trading coach analysing closed trades. Respond only with valid JSON.',
    });

    const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
    const cost = estimateCost(model, response.usage.input_tokens, response.usage.output_tokens);
    recordAiSpend(cost);
    recordAiCost(cost);

    const parsed = JSON.parse(text) as PostmortemResult;

    // Persist to DB
    try {
      getDb().prepare(`
        INSERT OR IGNORE INTO ai_decisions (context, reasoning, decision, model, tokens_used, cost_usd, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `postmortem:${params.symbol}:${params.action}`,
        `${parsed.lesson} [${parsed.patternTag}]`,
        parsed.classification,
        model,
        response.usage.input_tokens + response.usage.output_tokens,
        cost,
        1.0
      );
    } catch { /* DB insert failure is non-fatal */ }

    log.info('Postmortem analysis complete', {
      symbol: params.symbol,
      classification: parsed.classification,
      patternTag: parsed.patternTag,
      lesson: parsed.lesson,
    });

    return parsed;
  } catch (e) {
    log.debug('PostmortemAgent failed', { error: (e as Error).message });
    return null;
  }
}
