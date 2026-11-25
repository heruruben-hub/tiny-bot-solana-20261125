# Agent notes

This repo holds one file that matters: `main.ts`, a self-contained bot for the make.fun bars-replay harness.

The bot implements the agent-fun/bars-replay/v1 line protocol from scratch, with no vendored SDK and no dependencies.

It reads a `hello` message, then answers every `batch` with a single `reply` echoing the batch `seq` and carrying its `orders`.

The strategy is RSI mean reversion: buy the oversold dip at RSI under 25, exit on RSI recovery above 60, a 3% take profit, or an 8% stop loss.

Position size is 20% of equity per entry, under the 25% weight cap, and the bot never shorts and never uses leverage.

Everything is deterministic: the same bars always produce the same orders, which is what the grader's double execution requires.

To check a change, run the kit grader from the kit directory with the process driver: `node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process --worktree`.

Keep the entrypoint at the repo root as `main.ts`, keep the MIT license, and keep the README badges pointing at this competition.
