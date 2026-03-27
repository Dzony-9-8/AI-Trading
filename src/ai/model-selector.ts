import { getConfig } from '../config';
import { getBalance, getAiSpendToday } from '../core/state';

/**
 * Select the Claude model based on:
 * 1. Daily spend cap (hard override — spend cap ALWAYS wins)
 * 2. Current balance vs initial (tier-based upgrade)
 *
 * Spend cap check takes absolute precedence over balance tier.
 */
export function selectModel(): string {
  const config = getConfig();
  const { model_tiers, max_daily_spend_usd } = config.ai;

  // Rule 1: Spend cap — if exceeded, always use cheapest model
  const spendToday = getAiSpendToday();
  if (spendToday >= max_daily_spend_usd) {
    return model_tiers.bootstrap; // Haiku
  }

  // Rule 2: Balance-based tier
  const balance = getBalance();
  const initial = config.survival.initial_balance_usdt;

  // Well-funded: 50% above initial
  if (balance >= initial * 1.50) {
    return model_tiers.well_funded; // Opus
  }

  // Profitable: 10% above initial
  if (balance >= initial * 1.10) {
    return model_tiers.profitable; // Sonnet
  }

  // Bootstrap: at or below initial
  return model_tiers.bootstrap; // Haiku
}

/** Estimate cost of a Claude API call (approximate, in USD) */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing: Record<string, { input: number; output: number }> = {
    'claude-haiku-4-5-20251001': { input: 0.0000008, output: 0.000004 },
    'claude-sonnet-4-6':        { input: 0.000003,  output: 0.000015 },
    'claude-opus-4-6':          { input: 0.000015,  output: 0.000075 },
  };
  const p = pricing[model] ?? pricing['claude-haiku-4-5-20251001'];
  return inputTokens * p.input + outputTokens * p.output;
}
