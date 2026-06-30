import type {
  Classification,
  KnowledgeBase,
  ReconciliationReport,
  Scratchpad,
} from "../../domain/schemas.js";

/**
 * Stage 2 seam (locked decision #1): reconciliation sits behind this interface
 * so the default thin tool-call loop can later be swapped for an OpenAI
 * Agents SDK implementation without touching the pipeline. The tool
 * definitions (Zod-parameterized) are already SDK-function-tool shaped.
 */

export interface ReconciliationInput {
  kb: KnowledgeBase;
  jobId: string;
  classification: Classification;
  scratchpad: Scratchpad;
}

export interface ReconciliationOutput {
  report: ReconciliationReport;
  scratchpad: Scratchpad;
  stepsUsed: number;
}

export interface ReconciliationEngine {
  reconcile(input: ReconciliationInput): Promise<ReconciliationOutput>;
}
