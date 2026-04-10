/**
 * MIN-384: Agent-scoped namespace prefix — cross-agent isolation tests.
 *
 * Verifies that NamespacedKnowledgeGraphSession enforces {agentId}/{type}/
 * prefixes at the tool layer so Agent A cannot read or overwrite Agent B's
 * memory entries, even when both agents share the same underlying DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createKnowledgeGraphTools,
  KnowledgeGraphSession,
  NamespacedKnowledgeGraphSession,
} from "./knowledge-graph.js";
import { closeAndEvictDb, resetDbRegistryForTest } from "./typed-schema.js";

// Use a single shared in-memory DB to simulate the worst-case scenario:
// two agents sharing the same backing store.
const SHARED_DB_PATH = ":memory:";

beforeEach(() => {
  closeAndEvictDb(SHARED_DB_PATH);
  resetDbRegistryForTest();
});

afterEach(() => {
  closeAndEvictDb(SHARED_DB_PATH);
  resetDbRegistryForTest();
});

function openSharedSession(): KnowledgeGraphSession {
  return KnowledgeGraphSession.open(SHARED_DB_PATH);
}

// ── NamespacedKnowledgeGraphSession — core namespace behaviour ────────────────

describe("NamespacedKnowledgeGraphSession", () => {
  describe("remember / recallEntity isolation", () => {
    it("Agent A write is not visible to Agent B recall", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");
      const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");

      nsA.remember({ label: "secret-server", type: "entity" });

      // Agent B cannot find Agent A's entity
      expect(nsB.recallEntity("secret-server")).toBeNull();
    });

    it("Agent A can find its own entity", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");

      nsA.remember({ label: "my-server", type: "entity" });

      const found = nsA.recallEntity("my-server");
      expect(found).not.toBeNull();
      expect(found!.label).toBe("my-server"); // prefix stripped in output
    });

    it("Agent B entity does not pollute Agent A recall", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");
      const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");

      nsB.remember({ label: "shared-name", type: "entity" });
      nsA.remember({ label: "shared-name", type: "entity" });

      // Each agent gets its own entry
      const foundByA = nsA.recallEntity("shared-name");
      const foundByB = nsB.recallEntity("shared-name");
      expect(foundByA).not.toBeNull();
      expect(foundByB).not.toBeNull();
      // They are different objects (different stored IDs)
      expect(foundByA!.id).not.toBe(foundByB!.id);
    });
  });

  describe("searchFacts isolation", () => {
    it("Agent A search returns only its own facts", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");
      const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");

      nsA.remember({ label: "TypeScript is typed JavaScript", type: "fact" });
      nsB.remember({ label: "TypeScript compiles to JavaScript", type: "fact" });

      const resultsA = nsA.searchFacts("TypeScript");
      expect(resultsA).toHaveLength(1);
      expect(resultsA[0]!.label).toBe("TypeScript is typed JavaScript");
    });

    it("Agent B search does not return Agent A facts", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");
      const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");

      nsA.remember({ label: "private fact about production", type: "fact" });

      const resultsB = nsB.searchFacts("production");
      expect(resultsB).toHaveLength(0);
    });
  });

  describe("listByType isolation", () => {
    it("listByType returns only this agent's entries", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");
      const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");

      nsA.remember({ label: "entity-owned-by-a", type: "entity" });
      nsB.remember({ label: "entity-owned-by-b", type: "entity" });

      const listA = nsA.listByType("entity");
      expect(listA).toHaveLength(1);
      expect(listA[0]!.label).toBe("entity-owned-by-a");

      const listB = nsB.listByType("entity");
      expect(listB).toHaveLength(1);
      expect(listB[0]!.label).toBe("entity-owned-by-b");
    });
  });

  describe("forget isolation", () => {
    it("Agent A cannot delete Agent B's entry", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");
      const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");

      const id = nsB.remember({ label: "b-only-fact", type: "fact" });

      // Agent A tries to delete Agent B's object by ID
      nsA.forget(id);

      // Still exists for Agent B
      const obj = nsB.getMemoryObject(id);
      expect(obj).not.toBeNull();
    });

    it("Agent A can delete its own entry", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");

      const id = nsA.remember({ label: "a-deletable", type: "entity" });
      nsA.forget(id);

      expect(nsA.getMemoryObject(id)).toBeNull();
    });
  });

  describe("getMemoryObject isolation", () => {
    it("Agent A cannot read Agent B's object by id", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");
      const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");

      const id = nsB.remember({ label: "b-secret", type: "entity" });

      expect(nsA.getMemoryObject(id)).toBeNull();
    });

    it("Agent A can read its own object by id", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");

      const id = nsA.remember({ label: "a-own", type: "entity" });
      const obj = nsA.getMemoryObject(id);

      expect(obj).not.toBeNull();
      expect(obj!.label).toBe("a-own"); // prefix stripped
    });
  });

  describe("findRelated namespace filtering", () => {
    it("findRelated filters results to this agent's namespace", () => {
      const sharedDb = openSharedSession();
      const nsA = new NamespacedKnowledgeGraphSession(sharedDb, "agent-a");
      const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");

      const idA1 = nsA.remember({ label: "node-a1", type: "entity" });
      const idA2 = nsA.remember({ label: "node-a2", type: "entity" });
      nsA.linkObjects(idA1, idA2, "related_to");

      // Agent B writes an entity that happens to be related to A's node via raw id
      // (this shouldn't happen in practice but tests defense-in-depth)
      const idB1 = nsB.remember({ label: "node-b1", type: "entity" });
      // Link from A's db: would normally be filtered via namespace check on result
      nsA.linkObjects(idA1, idB1, "related_to");

      const related = nsA.findRelated(idA1);
      // Only A's own entry should appear (node-a2), not B's (node-b1)
      const labels = related.map((r) => r.label);
      expect(labels).toContain("node-a2");
      expect(labels).not.toContain("node-b1");
    });
  });

  describe("prefix scheme", () => {
    it("nsPrefix returns {agentId}/{type}/ format", () => {
      const session = openSharedSession();
      const ns = new NamespacedKnowledgeGraphSession(session, "my-agent");
      expect(ns.nsPrefix("entity")).toBe("my-agent/entity/");
      expect(ns.nsPrefix("fact")).toBe("my-agent/fact/");
      expect(ns.nsPrefix("skill")).toBe("my-agent/skill/");
    });
  });
});

// ── createKnowledgeGraphTools with agentId ────────────────────────────────────

describe("createKnowledgeGraphTools with agentId (namespace enforcement)", () => {
  it("remember tool stores in agent namespace; other agent cannot recall", async () => {
    const sharedDb = openSharedSession();
    const toolsA = createKnowledgeGraphTools(sharedDb, "agent-a");
    const toolsB = createKnowledgeGraphTools(sharedDb, "agent-b");

    const rememberA = toolsA.find((t) => t.name === "remember")!;
    await rememberA.execute("c1", { label: "agent-a-entity", type: "entity" });

    const recallB = toolsB.find((t) => t.name === "recall_entity")!;
    const result = await recallB.execute("c2", { name: "agent-a-entity" });
    expect((result.content[0] as { text: string }).text).toContain("No entity found");
  });

  it("recall_entity tool finds own namespace entry", async () => {
    const sharedDb = openSharedSession();
    const toolsA = createKnowledgeGraphTools(sharedDb, "agent-a");

    const rememberA = toolsA.find((t) => t.name === "remember")!;
    await rememberA.execute("c3", { label: "private-server", type: "entity" });

    const recallA = toolsA.find((t) => t.name === "recall_entity")!;
    const result = await recallA.execute("c4", { name: "private-server" });
    expect((result.content[0] as { text: string }).text).toContain("private-server");
  });

  it("search_facts tool only returns this agent's facts", async () => {
    const sharedDb = openSharedSession();
    const toolsA = createKnowledgeGraphTools(sharedDb, "agent-a");
    const toolsB = createKnowledgeGraphTools(sharedDb, "agent-b");

    const rememberA = toolsA.find((t) => t.name === "remember")!;
    const rememberB = toolsB.find((t) => t.name === "remember")!;
    await rememberA.execute("c5", { label: "agent-a uses Bun runtime", type: "fact" });
    await rememberB.execute("c6", { label: "agent-b uses Deno runtime", type: "fact" });

    const searchA = toolsA.find((t) => t.name === "search_facts")!;
    const resultA = await searchA.execute("c7", { query: "runtime" });
    expect((resultA.content[0] as { text: string }).text).toContain("Bun");
    expect((resultA.content[0] as { text: string }).text).not.toContain("Deno");
  });

  it("forget tool cannot delete another agent's entry", async () => {
    const sharedDb = openSharedSession();
    const toolsA = createKnowledgeGraphTools(sharedDb, "agent-a");
    const toolsB = createKnowledgeGraphTools(sharedDb, "agent-b");

    const nsB = new NamespacedKnowledgeGraphSession(sharedDb, "agent-b");
    const idB = nsB.remember({ label: "b-fact", type: "fact" });

    const forgetA = toolsA.find((t) => t.name === "forget")!;
    // Agent A tries to forget Agent B's id
    await forgetA.execute("c8", { id: idB });

    // Agent B's entry still exists
    expect(nsB.getMemoryObject(idB)).not.toBeNull();
  });
});
