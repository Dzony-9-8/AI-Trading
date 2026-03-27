import Anthropic from '@anthropic-ai/sdk';
import { log } from '../logger';
import { getDb } from '../data/db';
import { recordAiSpend } from '../core/state';
import { recordAiCost } from '../survival/economics';
import { selectModel, estimateCost } from './model-selector';

let _client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!process.env.CLAUDE_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _client;
}

export interface AIDecision {
  decision: string;
  reasoning: string;
  confidence: number; // 0–1
}

/**
 * Ask Claude to confirm or reject a rule-based trading signal.
 * Returns null if AI is disabled or call fails (bot falls back to rules).
 */
export async function confirmSignal(params: {
  symbol: string;
  action: string;
  ruleReasoning: string;
  indicators: Record<string, number | null>;
  balance: number;
  tier: string;
}): Promise<AIDecision | null> {
  const client = getClient();
  if (!client) return null;

  const model = selectModel();
  const context = buildContext(params);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: context,
      }],
      system: `You are the AI reasoning layer for a crypto trading bot.
Your job is to validate rule-based trading signals by considering broader market context.
You MUST respond with valid JSON only: {"decision": "confirm" | "reject", "reasoning": "...", "confidence": 0.0-1.0}
Be conservative — only confirm signals you have genuine confidence in. When in doubt, reject.`,
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const cost = estimateCost(model, inputTokens, outputTokens);

    // Track spend
    recordAiSpend(cost);
    recordAiCost(cost);

    // Parse response
    let parsed: { decision: string; reasoning: string; confidence: number };
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      log.warn('AI response was not valid JSON', { text });
      return null;
    }

    // Persist to DB
    getDb().prepare(`
      INSERT INTO ai_decisions (context, reasoning, decision, model, tokens_used, cost_usd, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      context,
      parsed.reasoning,
      parsed.decision,
      model,
      inputTokens + outputTokens,
      cost,
      parsed.confidence
    );

    log.debug('AI decision', {
      symbol: params.symbol,
      decision: parsed.decision,
      confidence: parsed.confidence,
      model,
      costUsd: cost.toFixed(5),
    });

    return {
      decision: parsed.decision,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
    };
  } catch (e) {
    log.warn('AI call failed — falling back to rules', { error: (e as Error).message });
    return null;
  }
}

function buildContext(params: {
  symbol: string;
  action: string;
  ruleReasoning: string;
  indicators: Record<string, number | null>;
  balance: number;
  tier: string;
}): string {
  const ind = Object.entries(params.indicators)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`)
    .join(', ');

  return `
Symbol: ${params.symbol}
Proposed action: ${params.action}
Rule engine reasoning: ${params.ruleReasoning}
Indicators: ${ind}
Account balance: $${params.balance.toFixed(2)} (tier: ${params.tier})

Should the bot execute this trade? Consider whether the technical setup is sound and the risk is appropriate.
Respond with JSON only: {"decision": "confirm" | "reject", "reasoning": "brief explanation", "confidence": 0.0-1.0}
`.trim();
}
