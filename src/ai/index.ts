/**
 * AI module gate.
 * All exports are null-safe — if CLAUDE_API_KEY is not set,
 * every function returns null silently and the bot runs rules-only.
 */
export { confirmSignal } from './claude';
export { selectModel } from './model-selector';

export function isAIEnabled(): boolean {
  return Boolean(process.env.CLAUDE_API_KEY);
}
