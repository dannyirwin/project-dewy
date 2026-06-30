import type { AppConfig } from "../config/index.js";
import { contentHash } from "../domain/hash.js";
import {
  type IngestionJob,
  type IngestionSource,
  IngestionSourceSchema,
} from "../domain/schemas.js";
import { KbConfigService } from "../kb/index.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/interfaces.js";
import type { Repositories } from "../repositories/interfaces.js";
import { SearchService } from "../retrieval/search.js";
import { ReviewService } from "../review/index.js";
import { VersioningService } from "../versioning/index.js";
import type { ReconciliationEngine } from "./reconciliation/engine.js";
import { ThinLoopReconciliationEngine } from "./reconciliation/thinLoop.js";
import { makeClassifiedStep, makeClassifyStep, makeReceivedStep } from "./stages/classify.js";
import { makeApplyingStep, makeProposingStep } from "./stages/propose.js";
import {
  makeAwaitingReviewStep,
  makeReconciledStep,
  makeReconcilingStep,
} from "./stages/reconcile.js";
import { IngestionStateMachine } from "./stateMachine.js";

/**
 * Composition root for the pipeline. Everything depends on interfaces
 * (Repositories, ChatProvider, EmbeddingProvider, ReconciliationEngine), so
 * tests inject in-memory repos + mock providers and production injects
 * Supabase + LM Studio — same wiring.
 */

export interface PipelineDeps {
  repos: Repositories;
  chat: ChatProvider;
  embeddings: EmbeddingProvider;
  cfg: AppConfig;
  /** Locked decision #1: swap in an Agents-SDK engine here, nothing else moves. */
  reconciliationEngine?: ReconciliationEngine;
}

export interface Pipeline {
  machine: IngestionStateMachine;
  search: SearchService;
  versioning: VersioningService;
  kbService: KbConfigService;
  review: ReviewService;
  ingest(knowledgeBaseId: string, source: IngestionSource): Promise<IngestionJob>;
}

export function buildPipeline(deps: PipelineDeps): Pipeline {
  const { repos, chat, embeddings, cfg } = deps;
  const search = new SearchService(repos, embeddings, cfg);
  const versioning = new VersioningService(repos, search);
  const kbService = new KbConfigService(repos, chat);
  const engine =
    deps.reconciliationEngine ?? new ThinLoopReconciliationEngine(chat, repos, search, cfg);

  const machine = new IngestionStateMachine(repos)
    .register("received", makeReceivedStep(repos))
    .register("classifying", makeClassifyStep(chat))
    .register("classified", makeClassifiedStep)
    .register("reconciling", makeReconcilingStep(repos, engine))
    .register("reconciled", makeReconciledStep(repos))
    .register("awaiting_review", makeAwaitingReviewStep(repos))
    .register(
      "proposing_edits",
      makeProposingStep({ repos, chat, embeddings, search, versioning, kbService, cfg }),
    )
    .register(
      "applying_edits",
      makeApplyingStep({ repos, chat, embeddings, search, versioning, kbService, cfg }),
    );

  const review = new ReviewService(repos, machine);

  return {
    machine,
    search,
    versioning,
    kbService,
    review,
    async ingest(knowledgeBaseId, source) {
      const parsed = IngestionSourceSchema.parse(source);
      return repos.ingestionJobs.create({
        knowledge_base_id: knowledgeBaseId,
        source: parsed,
        source_hash: contentHash(parsed.raw_text),
      });
    },
  };
}
