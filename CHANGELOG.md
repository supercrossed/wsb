# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

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


