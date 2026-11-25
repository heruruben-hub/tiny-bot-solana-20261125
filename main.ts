// Tiny Bot — RSI mean-reversion bot for the make.fun "Tiny Bot, Easy $2:
// Beat Buy-and-Hold on Solana" bounty.
//
// The bot speaks the agent-fun/bars-replay/v1 line protocol over stdin/stdout:
// the harness sends one JSON line at a time — first a `hello` message with the
// universe, capital, caps and fees, then one `batch` per hourly bar carrying
// the latest `bar` rows for every symbol plus the fills and account state,
// and finally a `done` message. For every `batch` the bot answers with exactly
// one reply line, echoing the batch's `seq` and carrying its `orders` (buys
// by notional in USDC, sells by quantity). Orders decided on a batch fill at
// the next bar's open, so every decision here is made on closed bars only.
//
// Strategy, in one paragraph: the dev window is a broad, choppy downtrend, so
// chasing momentum loses to fees and whipsaw. This bot instead buys the dip:
// when a symbol's 10-bar RSI drops under 25 (oversold) it buys a fifth of
// equity, and it exits when the RSI recovers above 60, when the price rises
// 3% over its fill (take profit) or when it falls 8% under its fill
// (stop loss). Most of the time it sits in cash, which is exactly what beats
// buy-and-hold when everything drifts down, while the oversold entries catch
// the bounces. No shorts, no leverage, no clock, no randomness: the same bars
// always produce the same orders.

import { createInterface } from 'node:readline';

// ---------------------------------------------------------------- protocol

const PROTOCOL = 'agent-fun/bars-replay/v1';

interface HelloSymbol {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}

interface Hello {
  type: 'hello';
  protocol: string;
  seed: string;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
}

interface Bar {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}

interface Fill {
  client_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected';
  reason: string | null;
  decided_bar: number;
  fill_bar: number;
  price: string;
  qty: string;
  notional_quote_units: string;
  fee_quote_units: string;
}

interface Account {
  cash_quote_units: string;
  positions: { symbol: string; qty: string; cost_quote_units: string }[];
  equity_quote_units: string;
}

interface Batch {
  type: 'batch';
  seq: number;
  t: number;
  bars: Bar[];
  fills: Fill[];
  account: Account;
}

type Order =
  | { side: 'buy'; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: 'sell'; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

// ---------------------------------------------------------------- tunables

const RSI_PERIOD = 10; // bars in the RSI window
const RSI_BUY = 25; // buy when RSI falls under this (oversold)
const RSI_SELL = 60; // sell when RSI recovers above this
const POSITION_BPS = 2000; // 20% of equity per entry (under the 25% weight cap)
const STOP_LOSS = 0.08; // sell if price falls 8% under the fill price
const TAKE_PROFIT = 0.03; // sell if price rises 3% over the fill price
const MAX_SLIPPAGE_BPS = 500; // 5%: wide enough for hourly gaps, tight vs extremes

// ---------------------------------------------------------------- state

let cfg: Hello | null = null;
let warmupBars = 0;
let quoteScale = 6;
const priceScale = new Map<string, number>();
const qtyScale = new Map<string, number>();
const closes = new Map<string, number[]>(); // closes in USDC, oldest first
const entryPrice = new Map<string, number>(); // fill price (USDC) of the open position
const positions = new Map<string, { qty: bigint; cost: bigint }>();
let cash = 0n;
let equity = 0n;
let orderNo = 1;

function nextClientId(): string {
  return `o${orderNo++}`;
}

/** Wilder's RSI over a close series; null until the window is full. */
function rsi(series: number[], period: number): number | null {
  if (series.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = series[i] - series[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < series.length; i++) {
    const d = series[i] - series[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Value of a position in quote units, from its qty and latest close. */
function positionValue(symbol: string, qty: bigint): bigint {
  const series = closes.get(symbol);
  const ps = priceScale.get(symbol);
  const qs = qtyScale.get(symbol);
  if (!series || series.length === 0 || ps === undefined || qs === undefined) return 0n;
  const closeRaw = BigInt(Math.round(series[series.length - 1] * 10 ** ps));
  return (qty * closeRaw * 10n ** BigInt(quoteScale)) / 10n ** BigInt(qs + ps);
}

// ---------------------------------------------------------------- decisions

/** Decide the orders for one batch, after its bars and account are folded in. */
function decideOrders(batch: Batch): Order[] {
  if (cfg === null) return [];
  // During warm-up every order is rejected, so stay silent and just build history.
  if (batch.seq < warmupBars) return [];
  const orders: Order[] = [];
  const maxOrders = cfg.caps.max_orders_per_bar;
  const minNotional = BigInt(cfg.fees.min_notional_quote_units);
  let spendLeft = cash; // sells in this reply never fund its buys

  for (const sym of cfg.symbols) {
    if (orders.length >= maxOrders) break;
    const symbol = sym.symbol;
    const series = closes.get(symbol);
    if (!series || series.length === 0) continue;
    const close = series[series.length - 1];
    const r = rsi(series, RSI_PERIOD);
    if (r === null) continue;
    const held = positions.get(symbol);
    const heldQty = held?.qty ?? 0n;

    if (heldQty === 0n) {
      // No position: buy the oversold dip, a quarter of equity at a time.
      if (r >= RSI_BUY) continue;
      const byWeight = (BigInt(cfg.caps.max_weight_bps) * equity) / 10000n;
      const byFraction = (BigInt(POSITION_BPS) * equity) / 10000n;
      let notional = byWeight < byFraction ? byWeight : byFraction;
      if (notional > spendLeft) notional = spendLeft;
      if (notional < minNotional) continue;
      orders.push({
        side: 'buy',
        client_id: nextClientId(),
        symbol,
        notional_quote_units: notional.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      spendLeft -= notional;
    } else {
      // Holding: exit on RSI recovery, take profit, or stop loss.
      const entry = entryPrice.get(symbol);
      const recovered = r > RSI_SELL;
      const stopped = entry !== undefined && close < entry * (1 - STOP_LOSS);
      const taken = entry !== undefined && close > entry * (1 + TAKE_PROFIT);
      if (!recovered && !stopped && !taken) continue;
      orders.push({
        side: 'sell',
        client_id: nextClientId(),
        symbol,
        qty: heldQty.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }
  return orders;
}

// ---------------------------------------------------------------- wire loop

function applyHello(msg: Hello): void {
  cfg = msg;
  warmupBars = msg.warmup_bars ?? 0;
  quoteScale = msg.capital.quote_scale;
  cash = BigInt(msg.capital.quote_units);
  equity = BigInt(msg.capital.quote_units);
  for (const s of msg.symbols) {
    priceScale.set(s.symbol, s.price_scale);
    qtyScale.set(s.symbol, s.qty_scale);
    closes.set(s.symbol, []);
  }
}

function applyBatch(batch: Batch): void {
  for (const b of batch.bars) {
    const ps = priceScale.get(b.symbol);
    if (ps === undefined) continue;
    closes.get(b.symbol)?.push(Number(BigInt(b.c)) / 10 ** ps);
  }
  // Record fill prices so exits can measure against what was actually paid.
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    const ps = priceScale.get(f.symbol);
    if (ps === undefined) continue;
    if (f.side === 'buy') entryPrice.set(f.symbol, Number(BigInt(f.price)) / 10 ** ps);
    else if (f.side === 'sell') entryPrice.delete(f.symbol);
  }
  cash = BigInt(batch.account.cash_quote_units);
  equity = BigInt(batch.account.equity_quote_units);
  positions.clear();
  for (const p of batch.account.positions) {
    positions.set(p.symbol, { qty: BigInt(p.qty), cost: BigInt(p.cost_quote_units) });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line) as { type: string };
  if (msg.type === 'hello') {
    const hello = msg as unknown as Hello;
    if (hello.protocol !== PROTOCOL) throw new Error(`unsupported protocol ${hello.protocol}`);
    applyHello(hello);
  } else if (msg.type === 'batch') {
    const batch = msg as unknown as Batch;
    if (cfg === null) throw new Error('batch before hello');
    applyBatch(batch);
    const orders = decideOrders(batch);
    const reply = JSON.stringify({ type: 'reply', seq: batch.seq, orders });
    if (!process.stdout.write(`${reply}\n`)) {
      await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
    }
  } else if (msg.type === 'done') {
    break;
  } else {
    throw new Error(`unknown message type ${msg.type}`);
  }
}
