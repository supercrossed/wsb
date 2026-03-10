# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [1.11.1] - 2026-03-09

Fix trade type button toggling in dashboard, fix DB migration crash on startup


## [1.11.0] - 2026-03-10

- **1DTE contract support**: trade bot can now buy next-day expiry SPY options instead of same-day (0DTE)
- **Theta-aware scoring for 1DTE**: option selection penalizes contracts with high theta decay relative to price, favoring contracts that retain value overnight
- **Overnight position hold**: 1DTE positions carry overnight and close on expiration day at 3:45 PM instead of same-day EOD
- **Later entry cutoff for 1DTE**: entry window extends to 1:00 PM EST (vs 11:00 AM for 0DTE) since theta decay is less severe
- **Trade type selector**: new 0DTE/1DTE toggle in bot edit panel and Trade Settings card, with trade type badge on bot card
- **DB migration**: safe table rebuild to update CHECK constraint for existing databases

## [1.10.0] - 2026-03-10

- VIX-aware position sizing: fetches live VIX from Yahoo Finance, adjusts position size per risk level (safe reduces in high-vol, yolo stays aggressive)
- VIX adjusts stop loss and profit targets in volatile markets (wider stops, higher targets)
- User-configurable VIX toggle per bot in dashboard settings
- VIX badge on bot card when enabled, GET /api/vix endpoint
- Reduced position monitor polling from 1s to 5s to stay within Alpaca rate limits

## [1.9.2] - 2026-03-09

- Fix option chain returning far OTM strikes by filtering to 5% range around ATM
- Increase contract limit from 50 to 100 for better coverage
- This was the root cause of today's failed trades (no contracts in ATM-3% zone)


## [1.9.1] - 2026-03-09

- Fix historical tracker overwriting market-hours signal with overnight data
- Once a day gets a directional recommendation (CALLS/PUTS), it stays locked in
- Add WSB food/cooking metaphor sentiment patterns (roasted bulls, bear meat, grilled bers)
- Dashboard recommendation card now shows trade bot's 48h time-decayed signal
- Steeper time-decay: 17.5h+ comments at 0.1x weight (was 0.3x)
- Trade bot retries on failed option lookup instead of giving up
- Initial trade delayed to 9:45 AM EST for quote availability
- Persistent file logging to logs/wsb.log


## [1.9.0] - 2026-03-09

- Dashboard recommendation card now shows the trade bot's actual 48h time-decayed signal instead of the current thread's sentiment
- New /api/sentiment/tradebot endpoint for real-time trade bot signal
- Steeper time-decay: 17.5h+ comments now 0.1x weight (was 0.3x), recent sentiment dominates
- Trade bot retries on failed option lookup instead of giving up for the day
- Initial trade delayed to 9:45 AM EST for quote availability after market open
- Diagnostic logging for option selection (chain size, rejection reasons)
- Persistent file logging to logs/wsb.log
- Disclaimers on sentiment and recommendation cards explaining data sources


## [1.8.1] - 2026-03-09

Fix trade bot not retrying after failed option lookup. Delay initial trade to 9:45 AM for quote availability. Add diagnostic logging to option selection and persistent file logging.


## [1.8.0] - 2026-03-09

- **Greeks-aware option scoring**: trade engine now fetches real delta, gamma, theta, vega, and implied volatility from Alpaca snapshots API; contract selection uses actual delta instead of proximity heuristic
- **Risk-level Greeks constraints**: Safe requires delta ≥ 0.20 and IV ≤ 30% (conservative, high-probability trades); Degen requires delta ≥ 0.05 and IV ≤ 50%; YOLO has no Greeks filters and searches the full ATM→3% OTM zone in one pass
- **Extended strike search**: when no contracts in the ATM→1.5% OTM zone are affordable, the engine searches 1.5%→3% OTM as a fallback (enables small accounts to trade)
- **No contract cap**: removed the arbitrary 100-contract limit; position size is now fully determined by risk level allocation (Safe 30%, Degen 50%, YOLO 70%)
- **Greeks in trade logs**: entry log messages now include Δ, Γ, Θ, and IV for post-trade analysis

## [1.7.1] - 2026-03-08

- **Hotfix**: fixed `var`/`const` variable conflict in SPY verdict code that caused a JavaScript SyntaxError, resulting in a completely blank dashboard with no data or navigation

## [1.7.0] - 2026-03-08

- **Trade performance tracking**: new Performance card on Trade Bot page with 8-stat grid (trades, win rate, total P&L, avg P&L, W/L record, best/worst trade, profit factor), round-trip trade history table, and P&L column in trade log
- **Equity timeline**: daily account equity snapshots captured at trade entry/exit and 4:01 PM EST, displayed as a Chart.js line chart on the Trade Bot page
- **Info tooltip popups**: ? icons now show floating popup bubbles above the icon instead of expanding the card; click anywhere to dismiss
- **SPY verdict fix**: when market is closed (weekends/after hours), the live verdict card now shows the last finalized historical outcome instead of computing a misleading comparison from stale weekend sentiment
- **Combined network stats**: merged separate Net RX/TX into single "Network" stat showing combined bandwidth + total data usage since boot

## [1.6.0] - 2026-03-08

- **About page**: new dashboard tab explaining how sentiment analysis works, the seven-layer pipeline, upvote weighting, inverse recommendations, and full trade bot mechanics (entry/exit logic, risk levels, option selection)
- **Sticky nav bar**: navigation tabs no longer scroll under the header
- **System card**: CPU temperature (Linux), total network data usage since boot, app version with live update status, info tooltips on "comments analyzed" and "weighted score"
- **Trade bot UX**: risk level badge and inline edit panel on each bot card (replaces hidden dropdown), risk buttons with Save instead of cycling popup
- **Trade engine**: safe risk level updated to 30%, HOLD retry at 10:00/10:30/11:00 AM with 11 AM cutoff (no longer skips the day on first HOLD)

## [1.5.0] - 2026-03-08

Added WSB degen slang to sentiment engine: bers/bols/buls misspellings with context-aware scoring (e.g. "bers r fuk" = bullish, "bols r fuk" = bearish), thundercock (bullish), joever/cooked (bearish), "us bols/bers" identity patterns, and bear/bull mocking phrases. Removed ambiguous standalone patterns that conflicted with context-aware ones.

## [1.4.1] - 2026-03-08

Captures Sunday 4 PM "What Are Your Moves Tomorrow" thread. Scheduler now polls both the weekend and overnight threads during the Sunday 4 PM → Monday 7 AM transition window so no comments are missed. All comments flow into the trade engine's 48h time-decay lookback for Monday's 9:30 AM trade evaluation.

## [1.4.0] - 2026-03-08

Trade engine now uses time-decay weighted sentiment: comments closer to market open count more (1.0x within 2.5h, 0.7x 2.5–5.5h, 0.5x 5.5–17.5h, 0.3x beyond). Pulls raw comments from a 48-hour lookback window and combines upvote weight with decay multiplier for more accurate trade signals.

## [1.3.2] - 2026-03-08

Hardened sentiment pipeline for trade accuracy: question-form comments dampened, non-financial NLP-only comments gated out, sarcasm + strong phrase conflicts resolve to neutral, layer disagreement halves confidence. Added missing market verbs (bounce, crater, recovery). Fixed /s sarcasm matching in URLs.

## [1.3.1] - 2026-03-08

Dashboard shows raw comment count and weighted score separately. Fixed rate limit death spiral on morechildren expansion. Data feed no longer overwrites live sentiment on restart.


## [1.3.0] - 2026-03-08

Enhanced sentiment analysis: upvote-weighted scoring, sarcasm detection, temporal awareness. Position monitor now checks every 1 second.


## [1.2.0] - 2026-03-07

Added 0DTE SPY options trade engine with sentiment-driven entry, real-time position monitoring, trailing stops, and configurable risk levels (Safe 20%, Degen 50%, YOLO 70%)


## [1.1.1] - 2026-03-06

Import daily sentiment data from GitHub on startup so exe users see current recommendation before Reddit scraping begins


## [1.1.0] - 2026-03-06

Added historical data feed: Pi pushes daily sentiment, inverse recommendations, and SPY accuracy data to GitHub so desktop exe users get backfilled on startup


