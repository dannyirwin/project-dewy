// Re-export domain types for repository consumers; Scratchpad gets an alias to
// avoid a name clash with the schema export in some import styles.
export type {
  AuditLog,
  Chunk,
  Document,
  DocumentTag,
  DocumentVersion,
  IngestionJob,
  IngestionSource,
  JobState,
  KbConfig,
  KnowledgeBase,
  Link,
  LinkRelation,
  ProposedAction,
  ReviewItem,
  Scratchpad as ScratchpadType,
  StageOutputs,
  Tag,
} from "../domain/schemas.js";
