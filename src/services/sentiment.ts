import Sentiment from "sentiment";
import type { Sentiment as SentimentType, SentimentResult } from "../types";

const analyzer = new Sentiment();

// --- Context-aware WSB phrase overrides ---
// These phrases have specific meaning in WSB context that generic NLP misreads.
// Scored on a -5 to +5 scale (negative = bearish, positive = bullish).
const WSB_PHRASE_SCORES: Array<{ pattern: RegExp; score: number }> = [
  // Bearish phrases that sound positive out of context
  { pattern: /\bmy\s+puts?\s+(about\s+to\s+|gonna\s+|going\s+to\s+|will\s+)?(rip|print|fly|moon|pay)/i, score: -4 },
  { pattern: /\bputs?\s+(are\s+)?(printing|ripping|flying|mooning|paying)/i, score: -4 },
  { pattern: /\bputs?\s+(go(ing)?\s+)?brr+/i, score: -4 },
  { pattern: /\bload(ed|ing)?\s+(up\s+)?(on\s+)?puts/i, score: -4 },
  { pattern: /\bbought\s+puts/i, score: -3 },
  { pattern: /\bbuying\s+puts/i, score: -3 },

  // Bullish phrases that sound negative out of context
  { pattern: /\bmy\s+calls?\s+(about\s+to\s+|gonna\s+|going\s+to\s+|will\s+)?(rip|print|fly|moon|pay)/i, score: 4 },
  { pattern: /\bcalls?\s+(are\s+)?(printing|ripping|flying|mooning|paying)/i, score: 4 },
  { pattern: /\bcalls?\s+(go(ing)?\s+)?brr+/i, score: 4 },
  { pattern: /\bload(ed|ing)?\s+(up\s+)?(on\s+)?calls/i, score: 4 },
  { pattern: /\bbought\s+calls/i, score: 3 },
  { pattern: /\bbuying\s+calls/i, score: 3 },
  { pattern: /\bbuy(ing)?\s+(the\s+)?dip/i, score: 3 },
  { pattern: /\bdiamonds?\s*hands?/i, score: 3 },
  { pattern: /\bto\s+the\s+moon/i, score: 4 },
  { pattern: /\bshort\s*squeeze/i, score: 4 },

  // Directional plays with tickers
  { pattern: /\b(SPY|QQQ|ES)\s*\d{3,4}\s*c\b/i, score: 4 },
  { pattern: /\b(SPY|QQQ|ES)\s*\d{3,4}\s*p\b/i, score: -4 },
  { pattern: /\b0dte\s*call/i, score: 3 },
  { pattern: /\b0dte\s*put/i, score: -3 },

  // Strongly bearish phrases
  { pattern: /\brug\s*pull/i, score: -4 },
  { pattern: /\bdead\s*cat\s*bounce/i, score: -3 },
  { pattern: /\bblood\s*(bath|red)/i, score: -4 },
  { pattern: /\bbag\s*hold(ing|er)?/i, score: -3 },
  { pattern: /\bgap\s*down/i, score: -3 },
  { pattern: /\bsell(ing)?\s*off/i, score: -3 },
  { pattern: /\bwe\s*(are\s+)?fuk/i, score: -4 },
  { pattern: /\br\s*fuk/i, score: -4 },
  { pattern: /\bbull(s)?\s*(are\s+)?(fuk|fked|fucked|trapped)/i, score: -4 },
  { pattern: /\bbear\s*market/i, score: -3 },

  // Strongly bullish phrases
  { pattern: /\bbull\s*run/i, score: 4 },
  { pattern: /\bfree\s*money/i, score: 3 },
  { pattern: /\bgap\s*up/i, score: 3 },
  { pattern: /\bbear(s)?\s*(are\s+)?(fuk|fked|fucked|trapped)/i, score: 4 },
  { pattern: /\ball\s*in/i, score: 3 },
  { pattern: /\bATH\b/, score: 3 },

  // Amplifiers with direction — "this is going to drill" vs "this is going to rip"
  { pattern: /\bgonna\s*(drill|tank|dump|crash|die)/i, score: -3 },
  { pattern: /\bgonna\s*(rip|fly|moon|pump|squeeze|print)/i, score: 3 },
  { pattern: /\babout\s*to\s*(drill|tank|dump|crash|die)/i, score: -3 },
  { pattern: /\babout\s*to\s*(rip|fly|moon|pump|squeeze|print)/i, score: 3 },
];

// Emoji sentiment mappings (WSB context)
const EMOJI_SCORES: Record<string, number> = {
  // Bullish emojis
  "\u{1F680}": 3,  // rocket
  "\u{1F4C8}": 2,  // chart increasing
  "\u{1F4B0}": 2,  // money bag
  "\u{1F4B5}": 1,  // dollar
  "\u{1F4B8}": 1,  // money with wings (could be loss, but WSB uses it bullishly)
  "\u{1F911}": 2,  // money-mouth face
  "\u{1F389}": 1,  // party popper
  "\u{1F44D}": 1,  // thumbs up
  "\u{1F525}": 2,  // fire (usually positive on WSB)
  "\u{1F48E}": 3,  // gem (diamond hands)
  "\u{1F64C}": 2,  // raised hands (diamond hands combo)
  "\u{1F91D}": 1,  // handshake
  "\u{2705}": 1,   // check mark
  "\u{1F7E2}": 2,  // green circle
  "\u{1F402}": 2,  // ox/bull

  // Bearish emojis
  "\u{1F4C9}": -2, // chart decreasing
  "\u{1F43B}": -3, // bear
  "\u{1F480}": -2, // skull
  "\u{2620}": -2,  // skull and crossbones
  "\u{1F4A9}": -1, // poop
  "\u{1F62D}": -1, // crying face
  "\u{1F622}": -1, // sad face
  "\u{1F44E}": -1, // thumbs down
  "\u{1F6A8}": -2, // rotating light (warning)
  "\u{1F534}": -2, // red circle
  "\u{26A0}": -1,  // warning
  "\u{1F92E}": -2, // vomiting
  "\u{1F921}": -2, // clown (you're a clown for this trade)
  "\u{1F3AA}": -1, // circus
};

// Additional WSB-specific words to inject into the sentiment library's lexicon
const WSB_LEXICON: Record<string, number> = {
  // Bullish
  "moon": 3,
  "mooning": 3,
  "tendies": 3,
  "tendie": 3,
  "lfg": 3,
  "bullish": 3,
  "squeeze": 2,
  "pump": 2,
  "pumping": 2,
  "rally": 2,
  "breakout": 2,
  "rip": 2,
  "ripping": 2,
  "calls": 2,
  "call": 1,
  "green": 2,
  "brr": 2,
  "brrr": 2,
  "print": 2,
  "printing": 2,
  "yolo": 1,
  "lambo": 3,
  "uppies": 2,

  // Bearish
  "bearish": -3,
  "drill": -3,
  "drilling": -3,
  "dump": -2,
  "dumping": -2,
  "tank": -2,
  "tanking": -2,
  "puts": -2,
  "put": -1,
  "red": -2,
  "crash": -3,
  "crashing": -3,
  "recession": -3,
  "rug": -2,
  "guh": -4,
  "fuk": -2,
  "wrecked": -3,
  "rekt": -3,
  "bagholder": -3,
  "bagholding": -3,
  "downies": -2,
  "cliff": -2,
  "fade": -1,

  // Profanity as amplifiers (contextual — these shift existing sentiment)
  "fucking": 1, // amplifier, slight positive bias (excitement)
  "fuckin": 1,
  "shit": -1,
  "damn": 0,
  "hell": 0,
  "ass": 0,
};

// Register WSB lexicon with the sentiment library
analyzer.registerLanguage("en", { labels: WSB_LEXICON });

// Common ticker pattern: $TICKER or known bare tickers
const TICKER_PATTERN = /\$([A-Z]{1,5})\b/g;
const BARE_TICKER_PATTERN = /\b(SPY|QQQ|AAPL|TSLA|NVDA|AMD|AMZN|GOOG|GOOGL|META|MSFT|NFLX|GME|AMC|PLTR|SOFI|RIVN|NIO|BABA|COIN|MARA|RIOT)\b/g;

function extractTickers(text: string): string[] {
  const tickers = new Set<string>();
  let match: RegExpExecArray | null;

  TICKER_PATTERN.lastIndex = 0;
  while ((match = TICKER_PATTERN.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  BARE_TICKER_PATTERN.lastIndex = 0;
  while ((match = BARE_TICKER_PATTERN.exec(text)) !== null) {
    tickers.add(match[1]);
  }

  return Array.from(tickers);
}

function scoreEmojis(text: string): number {
  let score = 0;
  for (const [emoji, value] of Object.entries(EMOJI_SCORES)) {
    let idx = text.indexOf(emoji);
    while (idx !== -1) {
      score += value;
      idx = text.indexOf(emoji, idx + emoji.length);
    }
  }
  return score;
}

function scoreWsbPhrases(text: string): number {
  let score = 0;
  for (const { pattern, score: phraseScore } of WSB_PHRASE_SCORES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      score += phraseScore;
    }
  }
  return score;
}

export function analyzeSentiment(text: string): SentimentResult {
  // 1. General NLP score from the sentiment library (analyzes full sentence)
  const nlpResult = analyzer.analyze(text);
  const nlpScore = nlpResult.comparative * 10; // Scale comparative score (-1 to 1) to roughly -10 to 10

  // 2. WSB context-aware phrase scoring
  const phraseScore = scoreWsbPhrases(text);

  // 3. Emoji scoring
  const emojiScore = scoreEmojis(text);

  // Combine scores: phrase patterns get highest weight since they're most WSB-specific
  // NLP handles general language, emojis add color
  const totalScore = nlpScore + (phraseScore * 1.5) + emojiScore;

  let sentiment: SentimentType;
  let confidence: number;

  // Threshold for directional call: total score must exceed +/- 1
  if (totalScore > 1) {
    sentiment = "bullish";
    confidence = Math.min(totalScore / 10, 1);
  } else if (totalScore < -1) {
    sentiment = "bearish";
    confidence = Math.min(Math.abs(totalScore) / 10, 1);
  } else {
    sentiment = "neutral";
    confidence = 1 - Math.abs(totalScore); // High confidence when score is near 0
  }

  return {
    sentiment,
    confidence: Math.round(confidence * 100) / 100,
    tickers: extractTickers(text),
  };
}

export function getInverseRecommendation(
  bullishPercent: number,
  bearishPercent: number,
): "BUY" | "SELL" | "HOLD" {
  // Inverse WSB: if WSB is bullish, we sell. If bearish, we buy.
  const spread = Math.abs(bullishPercent - bearishPercent);

  // Need at least 10% spread to make a directional call
  if (spread < 10) return "HOLD";

  if (bullishPercent > bearishPercent) return "SELL";
  return "BUY";
}
