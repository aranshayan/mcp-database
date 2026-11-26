import type { Connection as CallbackConnection } from "mysql2";
import mysql from "mysql2/promise";
import type { Adapter, ExecuteResult, Limits, Param, QueryResult, TableDescription, TableSummary } from "../types.js";
import { toJsonRow } from "../serialize.js";

export interface MysqlOptions {
  url: string;
  poolSize?: number;
}

const int = (n: number): number => Math.max(0, Math.trunc(n));

type Conn = mysql.PoolConnection;

/**
 * MySQL / MariaDB adapter.
 *
 * Queries run in `START TRANSACTION READ ONLY` with a per-session execution limit
 * (`MAX_EXECUTION_TIME` on MySQL, `max_statement_time` on MariaDB). Multi-statement mode is off.
 * `query` streams rows and stops reading after `maxRows + 1`, so a large result never has to
 * fit in memory. The server may still scan (or sort) more rows than that before the first row
 * arrives, so keep a `LIMIT` in large queries.
 */
export class MysqlAdapter implements Adapter {
  readonly dialect = "mysql" as const;
  private readonly pool: mysql.Pool;

  constructor(opts: MysqlOptions) {
    this.pool = mysql.createPool({
      uri: opts.url,
      connectionLimit: opts.poolSize ?? 3,
      multipleStatements: false,
      connectTimeout: 10_000,
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: false,
    });
    this.pool.on("connection", (conn) => {
      conn.on("error", () => {});
    });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  quoteIdent(name: string): string {
    return `\`${name.replaceAll("`", "``")}\``;
  }

  /**
   * Runs `fn` in a read-only transaction. `fn` calls `discard()` when it leaves the connection
   * in a state that cannot be reused (for example, in the middle of a result set).
   */
  private async readOnly<T>(fn: (conn: Conn, discard: () => void) => Promise<T>, timeoutMs?: number): Promise<T> {
    const conn = await this.pool.getConnection();
    let broken = false;
    let discarded = false;
    try {
      if (timeoutMs !== undefined) await applyTimeout(conn, timeoutMs);
      // DDL commits implicitly in MySQL and would escape a plain READ ONLY transaction, so the
      // session default is switched to read-only as well (execute() switches it back).
      await conn.query("SET SESSION TRANSACTION READ ONLY");
      await conn.query("START TRANSACTION READ ONLY");
      return await fn(conn, () => {
        discarded = true;
      });
    } catch (err) {
      broken = isConnectionError(err);
      throw err;
    } finally {
      if (discarded) closeNow(conn);
      else if (broken) conn.destroy();
      else {
        await conn.query("ROLLBACK").catch(() => {});
        conn.release();
      }
    }
  }

  private async rows<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    return this.readOnly(async (conn) => {
      const [rows] = await conn.query(sql, values);
      return rows as T[];
    });
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.rows<{ name: string }>(
      "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql','sys','performance_schema','information_schema') ORDER BY 1",
    );
    return rows.map((r) => r.name);
  }

  async listTables(schema?: string): Promise<TableSummary[]> {
    const rows = await this.rows<{ name: string; type: string; est: string | number | null }>(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS est
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) ORDER BY TABLE_NAME`,
      [schema ?? null],
    );
    return rows.map((r) => ({
      name: r.name,
      type: r.type === "BASE TABLE" ? "table" : r.type.toLowerCase().replace(" ", "_"),
      estimatedRows: r.est === null || r.est === undefined ? null : Number(r.est),
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableDescription> {
    const sch = schema ?? null;
    const columns = await this.rows<{
      name: string;
      type: string;
      nullable: string;
      dflt: string | null;
      key: string;
      comment: string;
    }>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt,
              COLUMN_KEY AS \`key\`, COLUMN_COMMENT AS comment
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [sch, table],
    );
    if (columns.length === 0) throw new Error(`Table or view "${schema ?? "current database"}.${table}" not found.`);

    const stats = await this.rows<{ name: string; non_unique: number; col: string | null; seq: number }>(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COALESCE(COLUMN_NAME, EXPRESSION) AS col, SEQ_IN_INDEX AS seq
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [sch, table],
    ).catch(async () =>
      // MariaDB has no EXPRESSION column.
      this.rows<{ name: string; non_unique: number; col: string | null; seq: number }>(
        `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [sch, table],
      ),
    );
    const byIndex = new Map<string, { unique: boolean; cols: string[] }>();
    for (const s of stats) {
      const entry = byIndex.get(s.name) ?? { unique: Number(s.non_unique) === 0, cols: [] };
      entry.cols.push(s.col ?? "<expression>");
      byIndex.set(s.name, entry);
    }

    const fkRows = await this.rows<{
      name: string;
      col: string;
      ref_schema: string;
      ref_table: string;
      ref_col: string;
      on_update: string;
      on_delete: string;
    }>(
      `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS ref_schema,
              k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_col,
              r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = COALESCE(?, DATABASE()) AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [sch, table],
    );
    const fkByName = new Map<string, typeof fkRows>();
    for (const row of fkRows) fkByName.set(row.name, [...(fkByName.get(row.name) ?? []), row]);
    const foreignKeys = [...fkByName.entries()].map(([name, group]) => {
      const first = group[0]!;
      const actions = [
        first.on_update !== "NO ACTION" && first.on_update !== "RESTRICT" ? `ON UPDATE ${first.on_update}` : "",
        first.on_delete !== "NO ACTION" && first.on_delete !== "RESTRICT" ? `ON DELETE ${first.on_delete}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `${name}: FOREIGN KEY (${group.map((g) => g.col).join(", ")}) REFERENCES ${first.ref_schema}.${first.ref_table} (${group
        .map((g) => g.ref_col)
        .join(", ")})${actions ? ` ${actions}` : ""}`;
    });

    return {
      schema: schema ?? null,
      table,
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable === "YES",
        default: c.dflt,
        primaryKey: c.key === "PRI",
        comment: c.comment || null,
      })),
      indexes: [...byIndex.entries()].map(([name, v]) => ({
        name,
        unique: v.unique,
        primary: name === "PRIMARY",
        columns: v.cols,
      })),
      foreignKeys,
    };
  }

  async query(sql: string, params: Param[], limits: Limits): Promise<QueryResult> {
    const started = performance.now();
    return this.readOnly(async (conn, discard) => {
      // Stream the rows and stop after maxRows + 1 instead of buffering the whole result set.
      // The promise wrapper cannot stream, so this goes through the underlying callback connection.
      const query = callbackConnection(conn).query({ sql, values: params, rowsAsArray: true });
      let columns: string[] = [];
      query.on("fields", (fields: unknown) => {
        if (Array.isArray(fields)) columns = (fields as Array<{ name: string }>).map((f) => f.name);
      });
      const rows: unknown[][] = [];
      let truncated = false;
      for await (const row of query.stream()) {
        // A statement without a result set yields an OK packet instead of rows.
        if (!Array.isArray(row)) continue;
        if (rows.length === limits.maxRows) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
      // Leaving the loop early destroys the stream, but the server is still sending the rest of
      // the result set on this connection, so it must not go back to the pool.
      if (truncated) discard();
      return {
        columns,
        rows: rows.map(toJsonRow),
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    }, limits.timeoutMs);
  }

  async execute(sql: string, params: Param[], limits: Limits): Promise<ExecuteResult> {
    const started = performance.now();
    const conn = await this.pool.getConnection();
    let broken = false;
    try {
      await applyTimeout(conn, limits.timeoutMs);
      await conn.query("SET SESSION TRANSACTION READ WRITE");
      await conn.query("START TRANSACTION");
      const [result] = await conn.query({ sql, values: params });
      await conn.query("COMMIT");
      const header = result as { affectedRows?: number; insertId?: number | string };
      return {
        affectedRows: header.affectedRows ?? null,
        lastInsertId: header.insertId ? header.insertId : null,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      broken = isConnectionError(err);
      if (!broken) await conn.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      if (broken) conn.destroy();
      else conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** MySQL: MAX_EXECUTION_TIME (ms, SELECT only). MariaDB: max_statement_time (seconds). */
async function applyTimeout(conn: Conn, timeoutMs: number): Promise<void> {
  try {
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${int(timeoutMs)}`);
  } catch {
    try {
      await conn.query(`SET SESSION max_statement_time = ${Math.max(1, Math.ceil(timeoutMs / 1000))}`);
    } catch {
      /* server supports neither; the row cap still applies */
    }
  }
}

/** The promise typings declare `PoolConnection.connection` as a promise connection; it is the callback one. */
function callbackConnection(conn: Conn): CallbackConnection {
  return conn.connection as unknown as CallbackConnection;
}

/**
 * Removes a connection from the pool and closes its socket at once. `destroy()` alone only
 * half-closes the socket, and mysql2 would keep reading (and dropping) the rest of an unfinished
 * result set. With the socket closed, the server's next write fails and it stops the query.
 */
function closeNow(conn: Conn): void {
  conn.destroy();
  (callbackConnection(conn) as unknown as { stream?: { destroy(): void } }).stream?.destroy();
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  return /^(ECONN|EPIPE|ETIMEDOUT|PROTOCOL_|ER_SERVER_SHUTDOWN)/.test(code);
}
