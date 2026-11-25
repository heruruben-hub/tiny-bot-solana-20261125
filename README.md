# Tiny Bot — Beat Buy-and-Hold on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/heruruben-hub/tiny-bot-solana-20261125/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/heruruben-hub/tiny-bot-solana-20261125/reward.svg)](https://make.fun)

A tiny paper-trading bot for the [make.fun](https://make.fun) competition "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".

The bot reads hourly Solana bars and trades seven symbols (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF) against USDC.

It speaks the agent-fun/bars-replay/v1 line protocol: one JSON line in per bar, one reply line out with its orders.

The idea is deliberately boring: in a choppy downtrend, chasing momentum just pays fees, so the bot buys the dip instead.

When a symbol's 10-bar RSI drops under 25, the bot buys a fifth of equity; it sells when the RSI recovers above 60, on a 3% take profit, or on an 8% stop loss.

Most of the time it sits in cash, which is exactly what beats buy-and-hold while everything drifts down, and the oversold entries catch the bounces.

On the dev window it scored +378.74 USDC net PnL over 26 trades with a 4.06% max drawdown, against −869.34 USDC for buy-and-hold.

Run it with Node 22: `node main.ts` — it needs no dependencies, no network, and no configuration.

---

Built for make.fun: https://make.fun/?ref=kh6903y0&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1
