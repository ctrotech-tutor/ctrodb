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

export function tokenize(text: string): string[] {
  if (!text || typeof text !== "string") return []

  const words = text.toLowerCase().split(/[^a-z0-9]+/)
  return [...new Set(words.filter((w) => w.length > 0 && !STOP_WORDS.has(w)))]
}
