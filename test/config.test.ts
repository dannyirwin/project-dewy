import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";

describe("config (Phase 0)", () => {
  it("loads with dev-safe defaults from an empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.PORT).toBe(3000);
    expect(cfg.EMBEDDING_DIMENSION).toBe(768);
    expect(cfg.RECONCILIATION_STEP_BUDGET).toBe(12);
    expect(cfg.PROPOSAL_STEP_BUDGET).toBe(20);
    expect(cfg.MCP_TOKEN).toBe("");
    expect(cfg.API_TOKEN).toBe("");
    expect(cfg.AUTO_APPLY_CONFIDENCE_THRESHOLD).toBeCloseTo(0.85);
  });

  it("coerces and overrides from env", () => {
    const cfg = loadConfig({
      PORT: "8080",
      EMBEDDING_DIMENSION: "1024",
      SEARCH_KEYWORD_WEIGHT: "2.5",
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.EMBEDDING_DIMENSION).toBe(1024);
    expect(cfg.SEARCH_KEYWORD_WEIGHT).toBe(2.5);
  });

  it("rejects invalid values loudly", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ AUTO_APPLY_CONFIDENCE_THRESHOLD: "1.5" })).toThrow();
  });
});
