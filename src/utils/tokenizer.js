
// src/utils/tokenizer.js

/**
 * A list of common "stop words" that are not useful for searching and will be ignored.
 * This list can be expanded over time.
 * @private
 * @type {Set<string>}
 */
const stopWords = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'did', 'do', 'does', 'doing', 'down',
  'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most',
  'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 's', 'same',
  'she', 'should', 'so', 'some', 'such', 't', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'you', 'your', 'yours', 'yourself', 'yourselves'
]);

/**
 * Converts a string of text into an array of meaningful search tokens.
 * This involves converting to lowercase, splitting into words, and removing stop words.
 *
 * @param {string | null | undefined} text - The input text to tokenize.
 * @returns {Array<string>} An array of unique, meaningful tokens.
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  // 1. Convert to lowercase and split into words using a regex that handles
  //    spaces and common punctuation. This will split on any non-alphanumeric character.
  const words = text.toLowerCase().split(/[^a-z0-9]+/);

  // 2. Filter out stop words and any empty strings that may result from the split.
  const meaningfulWords = words.filter(word => {
    return word.length > 0 && !stopWords.has(word);
  });

  // 3. Return only the unique tokens to avoid redundant processing later.
  return [...new Set(meaningfulWords)];
}



