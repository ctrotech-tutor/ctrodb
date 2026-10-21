import type { WriteContext } from "./types"

/**
 * Canonical write contexts.
 *
 * Frozen and shared so every write carries an unambiguous origin without
 * allocating per operation. Plugins receive one of these as their final hook
 * argument.
 */
export const LOCAL_WRITE: WriteContext = Object.freeze({ origin: "local" })
export const REMOTE_WRITE: WriteContext = Object.freeze({ origin: "remote" })
