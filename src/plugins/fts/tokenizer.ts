/**
 * Re-exported for compatibility: tokenisation is a query-level concept (the
 * `match()` predicate and the full-text index must agree on what a token is),
 * so the implementation lives in `src/query/tokenizer.ts`.
 */
export { type TokenizeOptions, tokenize } from "../../query/tokenizer"
