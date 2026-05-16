-- =============================================================
-- AI Wiki schema for Supabase / Postgres
-- Run in Supabase SQL editor, or `psql -f sql/schema.sql`.
--
-- IMPORTANT: if you change EMBEDDING_DIM in .env, change vector(N) below.
-- =============================================================

create extension if not exists vector;
create extension if not exists pg_trgm;

-- -------------------------------------------------------------
-- documents: one row per logical wiki page.
-- metadata is jsonb so the wiki stays content-agnostic.
-- -------------------------------------------------------------
create table if not exists documents (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null,
  body        text not null,
  metadata    jsonb not null default '{}'::jsonb,
  tags        text[] not null default '{}',
  source      text,                       -- file path, url, job id, etc.
  body_hash   text,                       -- sha256 of body for change detection
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists documents_metadata_gin on documents using gin (metadata);
create index if not exists documents_tags_gin     on documents using gin (tags);

-- -------------------------------------------------------------
-- chunks: searchable slices of a document.
-- chunk_hash lets ingest skip unchanged chunks (saves embedding tokens).
-- -------------------------------------------------------------
create table if not exists chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references documents(id) on delete cascade,
  position      int not null,
  heading_path  text,
  content       text not null,
  chunk_hash    text not null,
  embedding     vector(1536),             -- change N if you change embedding model
  tsv           tsvector generated always as (to_tsvector('english', content)) stored,
  created_at    timestamptz not null default now()
);

create index if not exists chunks_tsv_gin     on chunks using gin (tsv);
create index if not exists chunks_document_id on chunks (document_id);
create index if not exists chunks_hash        on chunks (document_id, chunk_hash);
create index if not exists chunks_embedding_hnsw
  on chunks using hnsw (embedding vector_cosine_ops);

-- -------------------------------------------------------------
-- relations: typed edges between documents.
-- Agents create these instead of (or in addition to) prose mentions,
-- which keeps cross-references queryable.
--
-- Example kinds: 'references', 'supersedes', 'derived-from',
--                'mentions-person', 'about-project'.
-- -------------------------------------------------------------
create table if not exists relations (
  id          uuid primary key default gen_random_uuid(),
  from_id     uuid not null references documents(id) on delete cascade,
  to_id       uuid not null references documents(id) on delete cascade,
  kind        text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (from_id, to_id, kind)
);

create index if not exists relations_from on relations (from_id, kind);
create index if not exists relations_to   on relations (to_id, kind);

-- -------------------------------------------------------------
-- jobs: postgres-backed work queue.
--
-- Why postgres and not SQS/Redis/etc:
--   * one less moving part
--   * SELECT FOR UPDATE SKIP LOCKED gives clean multi-worker semantics
--   * jobs are just rows you can inspect, replay, and audit
-- -------------------------------------------------------------
create table if not exists jobs (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,                       -- 'distill', 'reembed', ...
  payload         jsonb not null,
  status          text not null default 'queued',     -- queued|running|complete|failed
  attempts        int  not null default 0,
  max_attempts    int  not null default 3,
  last_error      text,
  idempotency_key text unique,                         -- skip duplicate enqueues
  scheduled_for   timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists jobs_pickup on jobs (status, scheduled_for)
  where status = 'queued';

-- Worker uses this to atomically claim the next ready job.
create or replace function claim_next_job()
returns jobs
language sql
as $$
  update jobs
  set status = 'running',
      started_at = now(),
      attempts = attempts + 1
  where id = (
    select id from jobs
    where status = 'queued' and scheduled_for <= now()
    order by scheduled_for asc
    for update skip locked
    limit 1
  )
  returning *;
$$;

-- -------------------------------------------------------------
-- agent_runs: audit log of agent invocations.
-- Records inputs, outputs, token usage, and decisions.
-- Useful for: debugging, cost tracking, replaying with a different model.
-- -------------------------------------------------------------
create table if not exists agent_runs (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid references jobs(id) on delete set null,
  agent         text not null,            -- 'distill', 'reconcile', ...
  provider      text,                     -- 'anthropic'|'openai'|'local'
  model         text,
  input         jsonb not null,
  output        jsonb,
  tokens_in     int,
  tokens_out    int,
  duration_ms   int,
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists agent_runs_job_id on agent_runs (job_id);
create index if not exists agent_runs_agent  on agent_runs (agent, created_at desc);

-- -------------------------------------------------------------
-- Hybrid search via Reciprocal Rank Fusion (keyword + vector).
-- -------------------------------------------------------------
create or replace function search_chunks(
  query_text       text,
  query_embedding  vector(1536),
  match_count      int     default 10,
  filter_metadata  jsonb   default '{}'::jsonb,
  filter_tags      text[]  default null,
  rrf_k            int     default 60
)
returns table (
  chunk_id        uuid,
  document_id     uuid,
  document_title  text,
  document_slug   text,
  heading_path    text,
  content         text,
  metadata        jsonb,
  tags            text[],
  score           float
)
language sql stable
as $$
  with
  keyword as (
    select
      c.id as chunk_id,
      row_number() over (
        order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', query_text)) desc
      ) as rank
    from chunks c
    join documents d on d.id = c.document_id
    where c.tsv @@ websearch_to_tsquery('english', query_text)
      and (filter_metadata = '{}'::jsonb or d.metadata @> filter_metadata)
      and (filter_tags is null or d.tags && filter_tags)
    limit match_count * 4
  ),
  semantic as (
    select chunk_id, rank from (
      select
        c.id as chunk_id,
        row_number() over (order by c.embedding <=> query_embedding) as rank
      from chunks c
      join documents d on d.id = c.document_id
      where c.embedding is not null
        and (filter_metadata = '{}'::jsonb or d.metadata @> filter_metadata)
        and (filter_tags is null or d.tags && filter_tags)
      order by c.embedding <=> query_embedding
      limit match_count * 4
    ) s
  ),
  fused as (
    select chunk_id, sum(1.0 / (rrf_k + rank))::float as score
    from (
      select chunk_id, rank from keyword
      union all
      select chunk_id, rank from semantic
    ) ranked
    group by chunk_id
    order by score desc
    limit match_count
  )
  select
    f.chunk_id,
    c.document_id,
    d.title  as document_title,
    d.slug   as document_slug,
    c.heading_path,
    c.content,
    d.metadata,
    d.tags,
    f.score
  from fused f
  join chunks    c on c.id = f.chunk_id
  join documents d on d.id = c.document_id
  order by f.score desc;
$$;

-- Keep updated_at fresh.
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists documents_set_updated_at on documents;
create trigger documents_set_updated_at
before update on documents
for each row execute function set_updated_at();
