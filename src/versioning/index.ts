import type { Document, DocumentVersion, SectionContent } from "../domain/schemas.js";
import type { Repositories } from "../repositories/interfaces.js";
import type { SearchService } from "../retrieval/search.js";
import { renderBody } from "../templates/index.js";

/**
 * Versioning + audit + rollback (locked decision #5, plan §10).
 * - Every mutation → new immutable document_version; current pointer advances.
 * - Every change → audit_log entry (before/after/reason/confidence/actor/job).
 * - Rollback repoints current_version_id and regenerates that version's chunks;
 *   the rollback itself is audited.
 */
export class VersioningService {
  constructor(
    private repos: Repositories,
    private search: SearchService,
  ) {}

  async createVersion(input: {
    document: Document;
    sections: SectionContent[];
    reason: string;
    jobId: string | null;
    configVersion: number | null;
    actor: string;
    confidence?: number | null;
  }): Promise<DocumentVersion> {
    const { document } = input;
    const prevVersionId = document.current_version_id;
    const versionNumber = (await this.repos.documentVersions.latestVersionNumber(document.id)) + 1;
    const body = renderBody(document.title, input.sections);

    const version = await this.repos.documentVersions.create({
      document_id: document.id,
      knowledge_base_id: document.knowledge_base_id,
      version: versionNumber,
      body_markdown: body,
      sections: input.sections,
      created_by_job_id: input.jobId,
      reason: input.reason,
      config_version: input.configVersion,
    });

    await this.repos.documents.update(document.id, { current_version_id: version.id });

    await this.repos.auditLogs.append({
      knowledge_base_id: document.knowledge_base_id,
      ingestion_job_id: input.jobId,
      entity_type: "document",
      entity_id: document.id,
      action: prevVersionId ? "update_version" : "create_version",
      before: prevVersionId ? { current_version_id: prevVersionId } : null,
      after: { current_version_id: version.id, version: versionNumber },
      reason: input.reason,
      confidence: input.confidence ?? null,
      actor: input.actor,
    });

    // Locked decision/§6: version change → chunk regeneration.
    await this.search.regenerateChunks(version);

    return version;
  }

  async rollback(input: {
    documentId: string;
    toVersion: number;
    actor: string;
    reason: string;
  }): Promise<DocumentVersion> {
    const doc = await this.repos.documents.getById(input.documentId);
    if (!doc) throw new Error(`document ${input.documentId} not found`);
    const versions = await this.repos.documentVersions.listByDocument(input.documentId);
    const target = versions.find((v) => v.version === input.toVersion);
    if (!target) throw new Error(`version ${input.toVersion} not found for document`);

    const before = doc.current_version_id;
    await this.repos.documents.update(doc.id, { current_version_id: target.id });
    await this.repos.auditLogs.append({
      knowledge_base_id: doc.knowledge_base_id,
      ingestion_job_id: null,
      entity_type: "document",
      entity_id: doc.id,
      action: "rollback",
      before: { current_version_id: before },
      after: { current_version_id: target.id, version: target.version },
      reason: input.reason,
      confidence: null,
      actor: input.actor,
    });
    await this.search.regenerateChunks(target);
    return target;
  }
}
