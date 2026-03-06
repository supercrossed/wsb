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

  // WSB meme phrases — bullish
  { pattern: /\bape(s)?\s+together\s+strong/i, score: 4 },
  { pattern: /\bstonks?\s+(only\s+)?go\s+up/i, score: 4 },
  { pattern: /\bhodl(ing)?\b/i, score: 3 },
  { pattern: /\bmoney\s*printer\s*(go(es)?\s+)?brr+/i, score: 4 },
  { pattern: /\bgain\s*porn/i, score: 3 },
  { pattern: /\bsqueeze\s*(is\s+)?(on|coming|starting|happening)/i, score: 4 },
  { pattern: /\bgamma\s*(ramp|squeeze)/i, score: 4 },
  { pattern: /\bbullish\s+(af|as\s+fuck|as\s+hell|asf)/i, score: 5 },
  { pattern: /\bfree\s*money\s*glitch/i, score: 3 },
  { pattern: /\bcan('t|not)\s+(go\s+)?tits\s*up/i, score: 3 },
  { pattern: /\bwe\s*(are\s+)?eating\s+good/i, score: 3 },
  { pattern: /\bcoiled\s+(spring|up)/i, score: 3 },
  { pattern: /\blet('s|s)?\s*(fuckin(g)?\s+)?go+\b/i, score: 3 },
  { pattern: /\bsend(ing)?\s+it/i, score: 3 },
  { pattern: /\bfomo\s*(ing|ed|'d)/i, score: 2 },
  { pattern: /\bpaper\s*hands?\s*(bitch(es)?|sold)/i, score: 3 },

  // WSB meme phrases — bearish
  { pattern: /\bloss\s*porn/i, score: -2 },
  { pattern: /\bbehind\s*(the\s+)?wendy('s|s)/i, score: -3 },
  { pattern: /\bcircuit\s*breaker/i, score: -4 },
  { pattern: /\bholding\s*(the\s+|these\s+)?bags?/i, score: -3 },
  { pattern: /\bcopium/i, score: -3 },
  { pattern: /\bbearish\s+(af|as\s+fuck|as\s+hell|asf)/i, score: -5 },
  { pattern: /\bmargin\s*call(ed)?/i, score: -4 },
  { pattern: /\bcatch(ing)?\s+(a\s+)?falling\s+knife/i, score: -3 },
  { pattern: /\bknife\s*catch(ing|er)?/i, score: -2 },
  { pattern: /\b(it('s|s)?\s+)?over\s+for\s+(us|bulls?|apes?)/i, score: -4 },
  { pattern: /\btrap(ped)?\s+(bull|long)/i, score: -3 },
  { pattern: /\btheta\s*(gang|burn|decay|crush)/i, score: -2 },
  { pattern: /\bIV\s*crush/i, score: -2 },
  { pattern: /\bblew\s+up\s+(my\s+)?(account|portfolio)/i, score: -4 },
  { pattern: /\bsell\s*(the\s+)?rip/i, score: -3 },
  { pattern: /\bgoing\s+to\s+(zero|0)\b/i, score: -5 },
  { pattern: /\b(this\s+is\s+)?the\s+top/i, score: -3 },
  { pattern: /\bguh+\b/i, score: -4 },
  { pattern: /\bwipe(d)?\s+out/i, score: -3 },

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

  // Bullish emojis (additional)
  "\u{1F98D}": 2,  // gorilla (ape)
  "\u{1F451}": 2,  // crown
  "\u{1F4AA}": 2,  // flexed bicep
  "\u{1F440}": 1,  // eyes (watching, interest)
  "\u{1F9E0}": 1,  // brain (wrinkle brain)
  "\u{1F3C6}": 2,  // trophy
  "\u{1F319}": 2,  // crescent moon
  "\u{1F315}": 2,  // full moon
  "\u{1F924}": 2,  // drooling face (money drool)
  "\u{1F37E}": 2,  // champagne

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
  "\u{1F494}": -2, // broken heart
  "\u{1F635}": -2, // face with spiral eyes (stunned)
  "\u{1F6BD}": -2, // toilet (flushed money)
  "\u{1F52A}": -2, // knife (falling knife)
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
  "hodl": 3,
  "hodling": 3,
  "stonk": 1,
  "stonks": 1,
  "ape": 2,
  "apes": 2,
  "undervalued": 3,
  "oversold": 2,
  "accumulating": 2,
  "accumulate": 2,
  "fomo": 1,
  "hopium": 1,
  "rocket": 2,
  "skyrocket": 3,
  "parabolic": 3,
  "BTFD": 3,
  "btd": 2,
  "multibagger": 3,
  "bagger": 2,
  "runner": 2,
  "ripper": 2,
  "explode": 2,
  "exploding": 2,
  "chad": 2,
  "gigachad": 3,
  "goated": 2,
  "based": 1,

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
  "copium": -2,
  "regarded": -1,
  "degen": -1,
  "overleveraged": -3,
  "overvalued": -3,
  "overbought": -2,
  "dilution": -3,
  "diluted": -3,
  "liquidated": -3,
  "liquidation": -3,
  "worthless": -4,
  "expired": -2,
  "capitulation": -3,
  "capitulate": -3,
  "delisted": -4,
  "bankruptcy": -4,
  "bankrupt": -4,
  "insolvent": -4,
  "trapped": -2,
  "underwater": -3,
  "ponzi": -3,
  "scam": -3,
  "fraud": -3,
  "nosedive": -3,
  "freefall": -4,
  "implode": -3,
  "imploding": -3,
  "nothingburger": -1,

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
): "CALLS" | "PUTS" | "HOLD" {
  // Inverse WSB: if WSB is bullish, we buy puts. If bearish, we buy calls.
  // Use bull/bear ratio (excluding neutrals) to match the UI display
  const directional = bullishPercent + bearishPercent;
  if (directional === 0) return "HOLD";

  const bullRatio = (bullishPercent / directional) * 100;
  const bearRatio = (bearishPercent / directional) * 100;
  const spread = Math.abs(bullRatio - bearRatio);

  // Need at least 5% spread in bull/bear ratio to make a directional call
  if (spread < 5) return "HOLD";

  if (bullRatio > bearRatio) return "PUTS";
  return "CALLS";
}
