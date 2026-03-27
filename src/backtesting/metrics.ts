export interface BacktestTrade {
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  entryTime: number;
  exitTime: number;
  action: string;
}

export interface BacktestMetrics {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  totalReturn: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  startingBalance: number;
  endingBalance: number;
  durationDays: number;
}

export function computeMetrics(
  trades: BacktestTrade[],
  startingBalance: number,
  durationDays: number
): BacktestMetrics {
  if (trades.length === 0) {
    return emptyMetrics(startingBalance, durationDays);
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const endingBalance = startingBalance + totalPnl;

  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Max drawdown
  let peak = startingBalance;
  let balance = startingBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    balance += trade.pnl;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    const ddPct = dd / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  // Sharpe Ratio (annualized, risk-free rate = 0)
  const returns = trades.map(t => t.pnl / startingBalance);
  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const tradesPerYear = (365 / durationDays) * trades.length;
  const sharpeRatio = stdDev > 0 ? (meanReturn * Math.sqrt(tradesPerYear)) / stdDev : 0;

  const totalReturn = endingBalance - startingBalance;
  const totalReturnPct = totalReturn / startingBalance;
  const annualizedReturnPct = durationDays > 0
    ? Math.pow(1 + totalReturnPct, 365 / durationDays) - 1
    : 0;

  // Sortino ratio (penalises only downside returns)
  const negativeReturns = returns.filter(r => r < 0);
  const downsideDeviation = Math.sqrt(
    negativeReturns.reduce((sum, r) => sum + r * r, 0) / Math.max(negativeReturns.length, 1)
  );
  const sortinoRatio = downsideDeviation > 0
    ? (meanReturn / downsideDeviation) * Math.sqrt(tradesPerYear)
    : 0;

  // Calmar ratio (annualized return / max drawdown)
  const calmarRatio = maxDrawdownPct > 0 ? annualizedReturnPct / maxDrawdownPct : 0;

  // Consecutive wins / losses
  let maxConsecWins = 0, maxConsecLosses = 0, curWins = 0, curLosses = 0;
  for (const t of trades) {
    if (t.pnl > 0) {
      curWins++;
      curLosses = 0;
      if (curWins > maxConsecWins) maxConsecWins = curWins;
    } else {
      curLosses++;
      curWins = 0;
      if (curLosses > maxConsecLosses) maxConsecLosses = curLosses;
    }
  }

  return {
    totalTrades: trades.length,
    winRate: wins.length / trades.length,
    avgWin,
    avgLoss,
    profitFactor,
    maxDrawdown,
    maxDrawdownPct,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    maxConsecWins,
    maxConsecLosses,
    totalReturn,
    totalReturnPct,
    annualizedReturnPct,
    startingBalance,
    endingBalance,
    durationDays,
  };
}

export function printMetrics(metrics: BacktestMetrics): void {
  const pct = (v: number) => (v * 100).toFixed(2) + '%';
  const usd = (v: number) => '$' + v.toFixed(2);

  console.log('\n' + '═'.repeat(50));
  console.log('  BACKTEST RESULTS');
  console.log('═'.repeat(50));
  console.log(`  Total Trades:       ${metrics.totalTrades}`);
  console.log(`  Win Rate:           ${pct(metrics.winRate)}`);
  console.log(`  Avg Win:            ${usd(metrics.avgWin)}`);
  console.log(`  Avg Loss:           ${usd(metrics.avgLoss)}`);
  console.log(`  Profit Factor:      ${metrics.profitFactor.toFixed(2)}`);
  console.log(`  Max Drawdown:       ${usd(metrics.maxDrawdown)} (${pct(metrics.maxDrawdownPct)})`);
  console.log(`  Sharpe Ratio:       ${metrics.sharpeRatio.toFixed(2)}`);
  console.log(`  Sortino Ratio:      ${metrics.sortinoRatio.toFixed(2)}`);
  console.log(`  Calmar Ratio:       ${metrics.calmarRatio.toFixed(2)}`);
  console.log(`  Max Consec Wins:    ${metrics.maxConsecWins}`);
  console.log(`  Max Consec Losses:  ${metrics.maxConsecLosses}`);
  console.log('─'.repeat(50));
  console.log(`  Starting Balance:   ${usd(metrics.startingBalance)}`);
  console.log(`  Ending Balance:     ${usd(metrics.endingBalance)}`);
  console.log(`  Total Return:       ${usd(metrics.totalReturn)} (${pct(metrics.totalReturnPct)})`);
  console.log(`  Annualized Return:  ${pct(metrics.annualizedReturnPct)}`);
  console.log(`  Duration:           ${metrics.durationDays} days`);
  console.log('═'.repeat(50) + '\n');
}

function emptyMetrics(startingBalance: number, durationDays: number): BacktestMetrics {
  return {
    totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0,
    profitFactor: 0, maxDrawdown: 0, maxDrawdownPct: 0,
    sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
    maxConsecWins: 0, maxConsecLosses: 0,
    totalReturn: 0, totalReturnPct: 0,
    annualizedReturnPct: 0, startingBalance, endingBalance: startingBalance, durationDays,
  };
}
