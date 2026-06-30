-- Initial schema. Column types mirror src/domain/schemas.ts (Zod is the source
-- of truth; this migration is derived from it).
--
-- Vector dimension is config-driven (locked decision #2): the embedding column is
-- declared WITHOUT a fixed dimension. The pgvector index, which requires a fixed
-- dimension, is generated separately by `pnpm db:vector-index` from
-- EMBEDDING_DIMENSION — see scripts/generate-vector-index.ts and the README.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------- knowledge_base ----------
create table knowledge_base (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  config jsonb not null,
  config_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- kb_config (versioned) ----------
create table kb_config (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  version integer not null,
  page_eligibility_rules jsonb not null,
  tag_policy jsonb not null,
  templates jsonb not null,
  default_template_id text not null,
  created_at timestamptz not null default now(),
  unique (knowledge_base_id, version)
);

-- ---------- document ----------
create table document (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  title text not null,
  slug text not null,
  current_version_id uuid,
  template_id text,
  status text not null default 'draft' check (status in ('draft','published')),
  content_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (knowledge_base_id, slug)
);
create index document_kb_idx on document(knowledge_base_id);

-- ---------- document_version (immutable) ----------
create table document_version (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references document(id) on delete cascade,
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  version integer not null,
  body_markdown text not null,
  sections jsonb not null default '[]',
  created_by_job_id uuid,
  reason text not null default '',
  config_version integer,
  created_at timestamptz not null default now(),
  unique (document_id, version)
);
create index document_version_doc_idx on document_version(document_id);
-- Full-text search over version bodies (keyword leg of hybrid retrieval).
alter table document_version
  add column fts tsvector generated always as (to_tsvector('english', body_markdown)) stored;
create index document_version_fts_idx on document_version using gin(fts);

alter table document
  add constraint document_current_version_fk
  foreign key (current_version_id) references document_version(id);

-- ---------- link ----------
create table link (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  from_document_id uuid not null references document(id) on delete cascade,
  to_document_id uuid not null references document(id) on delete cascade,
  relation text not null check (relation in ('related','mentions','parent','child','promoted_from')),
  anchor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (from_document_id, to_document_id, relation)
);
create index link_kb_idx on link(knowledge_base_id);
create index link_to_idx on link(to_document_id);

-- ---------- tag / document_tag ----------
create table tag (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('category','tag')),
  parent_id uuid references tag(id),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (knowledge_base_id, name)
);

create table document_tag (
  document_id uuid not null references document(id) on delete cascade,
  tag_id uuid not null references tag(id) on delete cascade,
  confidence real,
  source text not null check (source in ('ai','human')),
  created_at timestamptz not null default now(),
  primary key (document_id, tag_id)
);

-- ---------- chunk ----------
create table chunk (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  document_id uuid not null references document(id) on delete cascade,
  document_version_id uuid not null references document_version(id) on delete cascade,
  chunk_index integer not null,
  text text not null,
  embedding vector,            -- dimension intentionally unfixed; see header comment
  embedding_model text not null,
  dimension integer not null,
  token_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index chunk_kb_idx on chunk(knowledge_base_id);
create index chunk_doc_idx on chunk(document_id);

-- ---------- ingestion_job ----------
create table ingestion_job (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  source jsonb not null,
  source_hash text not null,
  state text not null default 'received' check (state in (
    'received','classifying','classified','reconciling','reconciled',
    'awaiting_review','proposing_edits','applying_edits','completed','failed')),
  stage_outputs jsonb not null default '{}',
  scratchpad jsonb not null default '{"version":1,"relevant_summaries":[],"entity_resolutions":[],"name_decisions":[],"notes":[],"review_context":[]}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ingestion_job_kb_idx on ingestion_job(knowledge_base_id);
create index ingestion_job_hash_idx on ingestion_job(knowledge_base_id, source_hash);

-- ---------- review_item ----------
create table review_item (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  ingestion_job_id uuid not null references ingestion_job(id) on delete cascade,
  kind text not null check (kind in (
    'ambiguous_fact','conflict','low_confidence','needs_context','taxonomy_change','proposed_action')),
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','resolved','skipped')),
  resolution jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index review_item_pending_idx on review_item(knowledge_base_id, status);

-- ---------- audit_log (append-only) ----------
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  ingestion_job_id uuid references ingestion_job(id),
  entity_type text not null,
  entity_id text not null,
  action text not null,
  before jsonb,
  after jsonb,
  reason text not null default '',
  confidence real,
  actor text not null,
  created_at timestamptz not null default now()
);
create index audit_log_job_idx on audit_log(ingestion_job_id);
create index audit_log_entity_idx on audit_log(entity_type, entity_id);

-- ---------- proposed_action ----------
create table proposed_action (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references knowledge_base(id) on delete cascade,
  ingestion_job_id uuid not null references ingestion_job(id) on delete cascade,
  type text not null check (type in (
    'create_document','append_section','update_section','upsert_link',
    'create_tag','apply_tag','promote_subsection')),
  payload jsonb not null,
  status text not null default 'proposed' check (status in ('proposed','approved','applied','rejected')),
  confidence real not null default 0,
  reason text not null default '',
  applied_version_id uuid references document_version(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index proposed_action_job_idx on proposed_action(ingestion_job_id);

-- ---------- RPC: semantic similarity over chunks ----------
create or replace function match_chunks(
  p_kb uuid,
  p_embedding vector,
  p_count integer default 10
) returns table (
  chunk_id uuid,
  document_id uuid,
  text text,
  similarity float
) language sql stable as $$
  select c.id, c.document_id, c.text,
         1 - (c.embedding <=> p_embedding) as similarity
  from chunk c
  join document d on d.id = c.document_id and d.current_version_id = c.document_version_id
  where c.knowledge_base_id = p_kb and c.embedding is not null
  order by c.embedding <=> p_embedding
  limit p_count;
$$;

-- ---------- RPC: keyword (FTS + trigram-free exact term) search ----------
create or replace function keyword_search(
  p_kb uuid,
  p_query text,
  p_count integer default 10
) returns table (
  document_id uuid,
  snippet text,
  rank float
) language sql stable as $$
  select d.id,
         ts_headline('english', dv.body_markdown, websearch_to_tsquery('english', p_query)),
         ts_rank(dv.fts, websearch_to_tsquery('english', p_query))::float
  from document d
  join document_version dv on dv.id = d.current_version_id
  where d.knowledge_base_id = p_kb
    and (dv.fts @@ websearch_to_tsquery('english', p_query)
         or dv.body_markdown ilike '%' || p_query || '%')
  order by 3 desc
  limit p_count;
$$;
