import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Low-level SQLite database handle, schema bootstrap, safe forward migrations,
 * and nested-savepoint transaction helper for Friday's state store.
 */
export class SqliteDb {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(readonly home: string) {
    this.db = new DatabaseSync(join(home, 'state.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,state);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operations_task ON operations(task_id);
      CREATE TABLE IF NOT EXISTS timers(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_id TEXT UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_tasks(message_id TEXT NOT NULL REFERENCES messages(id), task_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(message_id,task_id));
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, root_id TEXT NOT NULL, task_id TEXT, message_id TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_root ON journal(root_id,seq);
      CREATE INDEX IF NOT EXISTS journal_task ON journal(task_id,seq);
      CREATE INDEX IF NOT EXISTS journal_message ON journal(message_id,seq);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        cwd TEXT,
        superseded_by TEXT,
        updated_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER,
        last_reinforced_at INTEGER,
        importance INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_active ON memories(superseded_by, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_topic ON memories(topic, cwd);
      CREATE TABLE IF NOT EXISTS memory_embeddings(
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        dim INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS im_channels(id TEXT PRIMARY KEY, platform TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wechat_quote_cache(
        channel_id TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL,
        media_path TEXT,
        media_mime TEXT,
        media_name TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(channel_id, account_id, conversation_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS wechat_quote_cache_prune ON wechat_quote_cache(channel_id, account_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS notices(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_usage(
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        unit_input_usd REAL NOT NULL DEFAULT 0,
        unit_output_usd REAL NOT NULL DEFAULT 0,
        unit_cache_read_usd REAL NOT NULL DEFAULT 0,
        unit_cache_write_usd REAL NOT NULL DEFAULT 0,
        cost_source TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'completed',
        task_id TEXT,
        message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS model_usage_at ON model_usage(at);
      CREATE INDEX IF NOT EXISTS model_usage_model ON model_usage(provider, model, at);
    `);
    this.runSchemaMigrations();
  }

  private getUserVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
    return Number(row?.user_version ?? 0) || 0;
  }

  private runSchemaMigrations(): void {
    const version = this.getUserVersion();
    if (version < 1) {
      this.migrateMemoriesColumns();
      this.migrateMemoryEmbeddingsFk();
      this.db.exec('PRAGMA user_version = 1;');
    }
    if (version < 2) {
      this.migrateMemoriesPinnedColumn();
      this.db.exec('CREATE INDEX IF NOT EXISTS memories_active_pinned ON memories(superseded_by, pinned DESC, updated_at DESC);');
      this.db.exec('PRAGMA user_version = 2;');
    }
    if (version < 3) {
      this.migrateModelUsageCacheColumns();
      this.db.exec('PRAGMA user_version = 3;');
    }
  }

  private migrateModelUsageCacheColumns(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(model_usage)').all() as Array<Record<string, unknown>>)
        .map(row => String(row.name ?? '')),
    );
    this.transaction(() => {
      if (!cols.has('cache_write_1h_tokens')) {
        this.db.exec('ALTER TABLE model_usage ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0;');
      }
      if (!cols.has('unit_cache_read_usd')) {
        this.db.exec('ALTER TABLE model_usage ADD COLUMN unit_cache_read_usd REAL NOT NULL DEFAULT 0;');
      }
      if (!cols.has('unit_cache_write_usd')) {
        this.db.exec('ALTER TABLE model_usage ADD COLUMN unit_cache_write_usd REAL NOT NULL DEFAULT 0;');
      }
    });
  }

  private migrateMemoriesColumns(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(memories)').all() as Array<Record<string, unknown>>)
        .map(row => String(row.name ?? '')),
    );
    let addedColumn = false;
    this.transaction(() => {
      if (!cols.has('access_count')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;');
        addedColumn = true;
      }
      if (!cols.has('last_accessed_at')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER;');
        addedColumn = true;
      }
      if (!cols.has('last_reinforced_at')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN last_reinforced_at INTEGER;');
        addedColumn = true;
      }
      if (!cols.has('importance')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN importance INTEGER;');
        addedColumn = true;
      }
      if (addedColumn) {
        this.db.exec(`
          UPDATE memories
          SET
            access_count = coalesce(CAST(json_extract(body, '$.accessCount') AS INTEGER), access_count, 0),
            last_accessed_at = coalesce(CAST(json_extract(body, '$.lastAccessedAt') AS INTEGER), last_accessed_at),
            last_reinforced_at = coalesce(CAST(json_extract(body, '$.lastReinforcedAt') AS INTEGER), last_reinforced_at),
            importance = coalesce(CAST(json_extract(body, '$.importance') AS INTEGER), importance)
        `);
      }
    });
  }

  private migrateMemoriesPinnedColumn(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(memories)').all() as Array<Record<string, unknown>>)
        .map(row => String(row.name ?? '')),
    );
    this.transaction(() => {
      if (!cols.has('pinned')) {
        this.db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
        this.db.exec(`
          UPDATE memories
          SET pinned = CASE
            WHEN json_extract(body, '$.pinned') IN (1, '1', 'true') THEN 1
            ELSE 0
          END
        `);
      }
    });
  }

  private migrateMemoryEmbeddingsFk(): void {
    const fkRows = this.db.prepare('PRAGMA foreign_key_list(memory_embeddings)').all() as Array<Record<string, unknown>>;
    const hasCascadeFk = fkRows.some(row =>
      String(row.table ?? '') === 'memories'
      && String(row.from ?? '') === 'memory_id'
      && String(row.on_delete ?? '').toUpperCase() === 'CASCADE',
    );
    if (hasCascadeFk) return;

    this.transaction(() => {
      // Remove any orphaned embeddings first so FK creation succeeds on dirty pre-migration DBs.
      this.db.exec(`
        DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories);
        CREATE TABLE memory_embeddings_new(
          memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          dim INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          vector BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO memory_embeddings_new(memory_id, model_id, dim, content_hash, vector, updated_at)
        SELECT memory_id, model_id, dim, content_hash, vector, updated_at FROM memory_embeddings;
        DROP TABLE memory_embeddings;
        ALTER TABLE memory_embeddings_new RENAME TO memory_embeddings;
      `);
    });
  }

  transaction<T>(run: () => T): T {
    const level = this.depth;
    const savepoint = `nested_${level}`;
    this.db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth = level + 1;
    try {
      const result = run();
      this.db.exec(level === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (level === 0) {
          this.db.exec('ROLLBACK');
        } else {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch {
        // Preserve original error if rollback fails (e.g., connection closed or busy).
      }
      throw error;
    } finally {
      this.depth = level;
    }
  }

  close(): void {
    this.db.close();
  }
}
