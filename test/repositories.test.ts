import { describe, expect, it } from "vitest";
import { defaultKbConfig } from "../src/kb/index.js";
import { FakeEmbeddingProvider } from "../src/providers/mock.js";
import { createInMemoryRepositories } from "../src/repositories/memory/index.js";

describe("in-memory repositories (Phase 1)", () => {
  it("round-trips kb → document → version → link → tag → chunk", async () => {
    const repos = createInMemoryRepositories();
    const kb = await repos.knowledgeBases.create({
      name: "KB",
      slug: "kb",
      config: defaultKbConfig(),
    });

    const doc = await repos.documents.create({
      knowledge_base_id: kb.id,
      title: "Thornwick",
      slug: "thornwick",
      template_id: "place",
    });
    const v1 = await repos.documentVersions.create({
      document_id: doc.id,
      knowledge_base_id: kb.id,
      version: 1,
      body_markdown: "# Thornwick\n\nA river town.",
      sections: [],
      created_by_job_id: null,
      reason: "seed",
      config_version: 1,
    });
    await repos.documents.update(doc.id, { current_version_id: v1.id });

    const doc2 = await repos.documents.create({
      knowledge_base_id: kb.id,
      title: "Aldra Venn",
      slug: "aldra-venn",
      template_id: "person",
    });
    const { created } = await repos.links.upsert({
      knowledge_base_id: kb.id,
      from_document_id: doc.id,
      to_document_id: doc2.id,
      relation: "mentions",
    });
    expect(created).toBe(true);
    const again = await repos.links.upsert({
      knowledge_base_id: kb.id,
      from_document_id: doc.id,
      to_document_id: doc2.id,
      relation: "mentions",
    });
    expect(again.created).toBe(false); // dedupe

    const tag = await repos.tags.create({
      knowledge_base_id: kb.id,
      name: "settlement",
      kind: "tag",
    });
    await repos.documentTags.attach({
      document_id: doc.id,
      tag_id: tag.id,
      confidence: 0.9,
      source: "ai",
    });
    expect(await repos.documentTags.listByDocument(doc.id)).toHaveLength(1);

    // duplicate slug guard
    await expect(
      repos.documents.create({
        knowledge_base_id: kb.id,
        title: "T2",
        slug: "thornwick",
        template_id: null,
      }),
    ).rejects.toThrow(/already exists/);

    // unique tag name guard
    await expect(
      repos.tags.create({ knowledge_base_id: kb.id, name: "Settlement", kind: "tag" }),
    ).rejects.toThrow(/already exists/);
  });

  it("similaritySearch only matches current-version chunks and ranks by cosine", async () => {
    const repos = createInMemoryRepositories();
    const embeddings = new FakeEmbeddingProvider();
    const kb = await repos.knowledgeBases.create({
      name: "KB",
      slug: "kb",
      config: defaultKbConfig(),
    });
    const doc = await repos.documents.create({
      knowledge_base_id: kb.id,
      title: "Tavern",
      slug: "tavern",
      template_id: null,
    });
    const v1 = await repos.documentVersions.create({
      document_id: doc.id,
      knowledge_base_id: kb.id,
      version: 1,
      body_markdown: "old text",
      sections: [],
      created_by_job_id: null,
      reason: "",
      config_version: null,
    });
    const v2 = await repos.documentVersions.create({
      document_id: doc.id,
      knowledge_base_id: kb.id,
      version: 2,
      body_markdown: "The Gilded Anchor tavern is run by Bosun Pike",
      sections: [],
      created_by_job_id: null,
      reason: "",
      config_version: null,
    });
    await repos.documents.update(doc.id, { current_version_id: v2.id });

    const [oldVec] = (await embeddings.embed(["old text"])).vectors;
    const [newVec] = (await embeddings.embed(["The Gilded Anchor tavern is run by Bosun Pike"]))
      .vectors;
    await repos.chunks.insertMany([
      {
        knowledge_base_id: kb.id,
        document_id: doc.id,
        document_version_id: v1.id,
        chunk_index: 0,
        text: "old text",
        embedding: oldVec!,
        embedding_model: "fake",
        dimension: 64,
        token_count: 2,
      },
      {
        knowledge_base_id: kb.id,
        document_id: doc.id,
        document_version_id: v2.id,
        chunk_index: 0,
        text: "The Gilded Anchor tavern is run by Bosun Pike",
        embedding: newVec!,
        embedding_model: "fake",
        dimension: 64,
        token_count: 9,
      },
    ]);

    const { vectors } = await embeddings.embed(["who runs the Gilded Anchor tavern?"]);
    const hits = await repos.chunks.similaritySearch(kb.id, vectors[0]!, 5);
    expect(hits).toHaveLength(1); // stale v1 chunk excluded
    expect(hits[0]!.text).toContain("Gilded Anchor");
  });

  it("keywordSearch finds exact made-up proper nouns", async () => {
    const repos = createInMemoryRepositories();
    const kb = await repos.knowledgeBases.create({
      name: "KB",
      slug: "kb",
      config: defaultKbConfig(),
    });
    const doc = await repos.documents.create({
      knowledge_base_id: kb.id,
      title: "Zorblax",
      slug: "zorblax",
      template_id: null,
    });
    const v = await repos.documentVersions.create({
      document_id: doc.id,
      knowledge_base_id: kb.id,
      version: 1,
      body_markdown: "Zorblax the Unpronounceable guards the vault.",
      sections: [],
      created_by_job_id: null,
      reason: "",
      config_version: null,
    });
    await repos.documents.update(doc.id, { current_version_id: v.id });
    const hits = await repos.documents.keywordSearch(kb.id, "Zorblax", 5);
    expect(hits[0]!.document_id).toBe(doc.id);
  });

  it("ingestion job state + findBySourceHash", async () => {
    const repos = createInMemoryRepositories();
    const kb = await repos.knowledgeBases.create({
      name: "KB",
      slug: "kb",
      config: defaultKbConfig(),
    });
    const job = await repos.ingestionJobs.create({
      knowledge_base_id: kb.id,
      source: { raw_text: "x", metadata: {}, storage_ref: null },
      source_hash: "h1",
    });
    expect(job.state).toBe("received");
    await repos.ingestionJobs.update(job.id, { state: "classifying" });
    expect((await repos.ingestionJobs.getById(job.id))!.state).toBe("classifying");
    expect(await repos.ingestionJobs.findBySourceHash(kb.id, "h1")).toHaveLength(1);
    expect(await repos.ingestionJobs.findBySourceHash(kb.id, "h2")).toHaveLength(0);
  });
});
