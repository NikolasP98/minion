/**
 * Typed memory object schema — 8 object types + 5 relationship types.
 *
 * Extends (does not replace) the existing message ledger. Uses the same
 * node:sqlite pattern (DatabaseSync singleton, WAL pragmas).
 *
 * Object types:  entity | fact | event | preference | task | belief | interaction | skill
 * Relationship types: related_to | caused_by | part_of | precedes | contradicts
 *
 * @module
 */

import { applySqlitePragmas } from "./sqlite-pragmas.js";
import { requireNodeSqlite } from "./sqlite.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ObjectType =
  | "entity"
  | "fact"
  | "event"
  | "preference"
  | "task"
  | "belief"
  | "interaction"
  | "skill";

export type RelType = "related_to" | "caused_by" | "part_of" | "precedes" | "contradicts";

export type MemoryObject = {
  id: string;
  type: ObjectType;
  label: string;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Milliseconds from creation until expiry. NULL = permanent. */
  ttl: number | null;
};

export type MemoryRelationship = {
  fromId: string;
  toId: string;
  relType: RelType;
  weight: number;
  createdAt: number;
};

// ── Schema SQL ─────────────────────────────────────────────────────────────────

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS memory_objects (
  id         TEXT    PRIMARY KEY,
  type       TEXT    NOT NULL CHECK(type IN ('entity','fact','event','preference','task','belief','interaction','skill')),
  label      TEXT    NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ttl        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_objects_type      ON memory_objects(type);
CREATE INDEX IF NOT EXISTS idx_memory_objects_label     ON memory_objects(label);
CREATE INDEX IF NOT EXISTS idx_memory_objects_ttl       ON memory_objects(ttl) WHERE ttl IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_relationships (
  from_id    TEXT    NOT NULL REFERENCES memory_objects(id) ON DELETE CASCADE,
  to_id      TEXT    NOT NULL REFERENCES memory_objects(id) ON DELETE CASCADE,
  rel_type   TEXT    NOT NULL CHECK(rel_type IN ('related_to','caused_by','part_of','precedes','contradicts')),
  weight     REAL    NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, rel_type)
);

CREATE INDEX IF NOT EXISTS idx_memory_rels_from ON memory_relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_rels_to   ON memory_relationships(to_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_objects_fts USING fts5(
  id UNINDEXED,
  label,
  content='memory_objects',
  content_rowid='rowid'
);
`;

// ── Singleton ──────────────────────────────────────────────────────────────────

type DatabaseSync = InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>;

let db: DatabaseSync | null = null;

export function openTypedMemoryDb(dbPath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  db = new DatabaseSync(dbPath);
  applySqlitePragmas(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(INIT_SQL);
}

export function closeTypedMemoryDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
    db = null;
  }
}

export function getTypedMemoryDb(): DatabaseSync | null {
  return db;
}

/** For tests — resets the singleton without closing. */
export function resetTypedMemoryDbForTest(): void {
  db = null;
}

function requireDb(): DatabaseSync {
  if (!db) {
    throw new Error("Typed memory DB not initialised — call openTypedMemoryDb() first");
  }
  return db;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

function encodeData(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return "{}";
  }
}

function decodeData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToMemoryObject(row: Record<string, unknown>): MemoryObject {
  return {
    id: String(row["id"]),
    type: row["type"] as ObjectType,
    label: String(row["label"]),
    data: decodeData(row["data"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
    ttl: row["ttl"] == null ? null : Number(row["ttl"]),
  };
}

function rowToRelationship(row: Record<string, unknown>): MemoryRelationship {
  return {
    fromId: String(row["from_id"]),
    toId: String(row["to_id"]),
    relType: row["rel_type"] as RelType,
    weight: Number(row["weight"]),
    createdAt: Number(row["created_at"]),
  };
}

// ── CRUD: Objects ──────────────────────────────────────────────────────────────

/** Create a new memory object. Returns the id. */
export function createObject(params: {
  id: string;
  type: ObjectType;
  label: string;
  data?: Record<string, unknown>;
  ttl?: number | null;
}): string {
  const now = nowMs();
  requireDb()
    .prepare(
      `INSERT INTO memory_objects (id, type, label, data, created_at, updated_at, ttl)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.id,
      params.type,
      params.label,
      encodeData(params.data ?? {}),
      now,
      now,
      params.ttl ?? null,
    );
  return params.id;
}

/** Get a memory object by id. Returns null if not found. */
export function getObject(id: string): MemoryObject | null {
  const row = requireDb().prepare("SELECT * FROM memory_objects WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMemoryObject(row) : null;
}

/** Update label and/or data for an existing object. */
export function updateObject(
  id: string,
  updates: { label?: string; data?: Record<string, unknown>; ttl?: number | null },
): void {
  const obj = getObject(id);
  if (!obj) {
    return;
  }
  const newLabel = updates.label ?? obj.label;
  const newData = updates.data !== undefined ? updates.data : obj.data;
  const newTtl = "ttl" in updates ? (updates.ttl ?? null) : obj.ttl;
  requireDb()
    .prepare(`UPDATE memory_objects SET label = ?, data = ?, ttl = ?, updated_at = ? WHERE id = ?`)
    .run(newLabel, encodeData(newData), newTtl, nowMs(), id);
}

/** Delete a memory object (and cascade-delete its relationships). */
export function deleteObject(id: string): void {
  requireDb().prepare("DELETE FROM memory_objects WHERE id = ?").run(id);
}

/** List all objects of a given type. */
export function listObjectsByType(type: ObjectType): MemoryObject[] {
  const rows = requireDb()
    .prepare("SELECT * FROM memory_objects WHERE type = ? ORDER BY updated_at DESC")
    .all(type) as Record<string, unknown>[];
  return rows.map(rowToMemoryObject);
}

/** Prune all objects whose TTL has expired (createdAt + ttl < now). */
export function pruneExpiredObjects(): number {
  const now = nowMs();
  const result = requireDb()
    .prepare("DELETE FROM memory_objects WHERE ttl IS NOT NULL AND (created_at + ttl) < ?")
    .run(now);
  return Number(result.changes ?? 0);
}

// ── CRUD: Relationships ────────────────────────────────────────────────────────

/** Create or replace a relationship between two objects. */
export function createRelationship(params: {
  fromId: string;
  toId: string;
  relType: RelType;
  weight?: number;
}): void {
  const now = nowMs();
  requireDb()
    .prepare(
      `INSERT OR REPLACE INTO memory_relationships (from_id, to_id, rel_type, weight, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(params.fromId, params.toId, params.relType, params.weight ?? 1.0, now);
}

/** Get all objects related to the given id, optionally filtered by relationship type. */
export function getRelated(id: string, relType?: RelType): MemoryObject[] {
  const db = requireDb();
  const rows: Record<string, unknown>[] = relType
    ? (db
        .prepare(
          `SELECT o.* FROM memory_objects o
           JOIN memory_relationships r ON o.id = r.to_id
           WHERE r.from_id = ? AND r.rel_type = ?
           ORDER BY r.weight DESC`,
        )
        .all(id, relType) as Record<string, unknown>[])
    : (db
        .prepare(
          `SELECT o.* FROM memory_objects o
           JOIN memory_relationships r ON o.id = r.to_id
           WHERE r.from_id = ?
           ORDER BY r.weight DESC`,
        )
        .all(id) as Record<string, unknown>[]);
  return rows.map(rowToMemoryObject);
}

/** Get all relationships where the given id is the source. */
export function getRelationshipsFrom(id: string): MemoryRelationship[] {
  const rows = requireDb()
    .prepare("SELECT * FROM memory_relationships WHERE from_id = ?")
    .all(id) as Record<string, unknown>[];
  return rows.map(rowToRelationship);
}

/** Delete a specific relationship. */
export function deleteRelationship(fromId: string, toId: string, relType: RelType): void {
  requireDb()
    .prepare("DELETE FROM memory_relationships WHERE from_id = ? AND to_id = ? AND rel_type = ?")
    .run(fromId, toId, relType);
}

// ── FTS Search ─────────────────────────────────────────────────────────────────

/**
 * Full-text search over memory object labels.
 * Searches across all types unless a type filter is provided.
 */
export function searchObjects(query: string, type?: ObjectType): MemoryObject[] {
  const db = requireDb();
  // Rebuild FTS index from current content
  db.exec("INSERT INTO memory_objects_fts(memory_objects_fts) VALUES('rebuild')");
  // Sanitize: remove FTS5 operator characters (quotes, wildcards, hyphens, dots)
  // Hyphens are FTS5 NOT operators; dots cause syntax errors.
  const sanitized = query.replace(/['"*/\-.]/g, " ").trim();
  if (!sanitized) {
    return [];
  }
  // Use subquery to avoid FTS5 JOIN complications with content tables.
  // The FTS5 rowid corresponds to memory_objects.rowid via content_rowid='rowid'.
  const rows: Record<string, unknown>[] = type
    ? (db
        .prepare(
          `SELECT * FROM memory_objects
           WHERE rowid IN (
             SELECT rowid FROM memory_objects_fts WHERE memory_objects_fts MATCH ?
           ) AND type = ?`,
        )
        .all(sanitized, type) as Record<string, unknown>[])
    : (db
        .prepare(
          `SELECT * FROM memory_objects
           WHERE rowid IN (
             SELECT rowid FROM memory_objects_fts WHERE memory_objects_fts MATCH ?
           )`,
        )
        .all(sanitized) as Record<string, unknown>[]);
  return rows.map(rowToMemoryObject);
}

// ── Per-path registry ──────────────────────────────────────────────────────────

const _registry = new Map<string, DatabaseSync>();

/**
 * Open (or return from cache) a DatabaseSync instance for the given path.
 * The instance is initialised with WAL pragmas and the typed memory schema.
 */
export function getOrOpenDb(dbPath: string): DatabaseSync {
  let registeredDb = _registry.get(dbPath);
  if (!registeredDb) {
    const { DatabaseSync } = requireNodeSqlite();
    registeredDb = new DatabaseSync(dbPath);
    applySqlitePragmas(registeredDb);
    registeredDb.exec("PRAGMA foreign_keys = ON");
    registeredDb.exec(INIT_SQL);
    _registry.set(dbPath, registeredDb);
  }
  return registeredDb;
}

/** Close and remove a registered DB instance. */
export function closeAndEvictDb(dbPath: string): void {
  const registeredDb = _registry.get(dbPath);
  if (registeredDb) {
    try {
      registeredDb.close();
    } catch {
      // ignore close errors
    }
    _registry.delete(dbPath);
  }
}

/** For tests — clears the registry without closing any open handles. */
export function resetDbRegistryForTest(): void {
  _registry.clear();
}

// ── InDb CRUD variants (accept explicit db handle, used by KnowledgeGraphSession) ─

export function createObjectInDb(
  db: DatabaseSync,
  params: {
    id: string;
    type: ObjectType;
    label: string;
    data?: Record<string, unknown>;
    ttl?: number | null;
  },
): string {
  const now = nowMs();
  db.prepare(
    `INSERT INTO memory_objects (id, type, label, data, created_at, updated_at, ttl)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.type,
    params.label,
    encodeData(params.data ?? {}),
    now,
    now,
    params.ttl ?? null,
  );
  return params.id;
}

export function getObjectInDb(db: DatabaseSync, id: string): MemoryObject | null {
  const row = db.prepare("SELECT * FROM memory_objects WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMemoryObject(row) : null;
}

export function updateObjectInDb(
  db: DatabaseSync,
  id: string,
  updates: { label?: string; data?: Record<string, unknown>; ttl?: number | null },
): void {
  const obj = getObjectInDb(db, id);
  if (!obj) {
    return;
  }
  const newLabel = updates.label ?? obj.label;
  const newData = updates.data !== undefined ? updates.data : obj.data;
  const newTtl = "ttl" in updates ? (updates.ttl ?? null) : obj.ttl;
  db.prepare(
    `UPDATE memory_objects SET label = ?, data = ?, ttl = ?, updated_at = ? WHERE id = ?`,
  ).run(newLabel, encodeData(newData), newTtl, nowMs(), id);
}

export function deleteObjectInDb(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM memory_objects WHERE id = ?").run(id);
}

export function listObjectsByTypeInDb(db: DatabaseSync, type: ObjectType): MemoryObject[] {
  const rows = db
    .prepare("SELECT * FROM memory_objects WHERE type = ? ORDER BY updated_at DESC")
    .all(type) as Record<string, unknown>[];
  return rows.map(rowToMemoryObject);
}

/** List all memory objects, newest first. */
export function listAllObjectsInDb(db: DatabaseSync): MemoryObject[] {
  const rows = db.prepare("SELECT * FROM memory_objects ORDER BY updated_at DESC").all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToMemoryObject);
}

/** List all relationships. */
export function listAllRelationshipsInDb(db: DatabaseSync): MemoryRelationship[] {
  const rows = db.prepare("SELECT * FROM memory_relationships").all() as Record<string, unknown>[];
  return rows.map(rowToRelationship);
}

export function getRelatedInDb(db: DatabaseSync, id: string, relType?: RelType): MemoryObject[] {
  const rows: Record<string, unknown>[] = relType
    ? (db
        .prepare(
          `SELECT o.* FROM memory_objects o
           JOIN memory_relationships r ON o.id = r.to_id
           WHERE r.from_id = ? AND r.rel_type = ?
           ORDER BY r.weight DESC`,
        )
        .all(id, relType) as Record<string, unknown>[])
    : (db
        .prepare(
          `SELECT o.* FROM memory_objects o
           JOIN memory_relationships r ON o.id = r.to_id
           WHERE r.from_id = ?
           ORDER BY r.weight DESC`,
        )
        .all(id) as Record<string, unknown>[]);
  return rows.map(rowToMemoryObject);
}

export function createRelationshipInDb(
  db: DatabaseSync,
  params: { fromId: string; toId: string; relType: RelType; weight?: number },
): void {
  const now = nowMs();
  db.prepare(
    `INSERT OR REPLACE INTO memory_relationships (from_id, to_id, rel_type, weight, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(params.fromId, params.toId, params.relType, params.weight ?? 1.0, now);
}

export function searchObjectsInDb(
  db: DatabaseSync,
  query: string,
  type?: ObjectType,
): MemoryObject[] {
  db.exec("INSERT INTO memory_objects_fts(memory_objects_fts) VALUES('rebuild')");
  const sanitized = query.replace(/['"*/\-.]/g, " ").trim();
  if (!sanitized) {
    return [];
  }
  const rows: Record<string, unknown>[] = type
    ? (db
        .prepare(
          `SELECT * FROM memory_objects
           WHERE rowid IN (
             SELECT rowid FROM memory_objects_fts WHERE memory_objects_fts MATCH ?
           ) AND type = ?`,
        )
        .all(sanitized, type) as Record<string, unknown>[])
    : (db
        .prepare(
          `SELECT * FROM memory_objects
           WHERE rowid IN (
             SELECT rowid FROM memory_objects_fts WHERE memory_objects_fts MATCH ?
           )`,
        )
        .all(sanitized) as Record<string, unknown>[]);
  return rows.map(rowToMemoryObject);
}
