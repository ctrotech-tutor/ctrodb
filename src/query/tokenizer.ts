const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "if",
  "in",
  "into",
  "is",
  "it",
  "no",
  "not",
  "of",
  "on",
  "or",
  "such",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "will",
  "with",
])

export interface TokenizeOptions {
  /** Keep stop words. Used by tests and by callers that want raw tokens. */
  keepStopWords?: boolean
}

export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  if (!text || typeof text !== "string") return []

  const words = text.toLowerCase().split(/[^a-z0-9]+/)
  return [
    ...new Set(words.filter((w) => w.length > 0 && (options.keepStopWords || !STOP_WORDS.has(w)))),
  ]
}
