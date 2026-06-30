/**
 * Load `.env` from the project root into `process.env`.
 * Import this module first in live entrypoints (server, seed, smoke scripts).
 * Offline tests call `loadConfig({})` directly and never import this file.
 */
import { config } from "dotenv";

config();
