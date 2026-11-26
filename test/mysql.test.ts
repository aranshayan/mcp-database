import mysql from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MysqlAdapter } from "../src/adapters/mysql.js";
import { connect as baseConnect } from "./helpers.js";

// Runs against a real MySQL / MariaDB when TEST_MYSQL_URL is set, e.g.
//   TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/test_db npm test
// The target database is DROPPED AND RECREATED TABLES — use a scratch database.
const url = process.env.TEST_MYSQL_URL;
const suite = url ? describe : describe.skip;

suite("mysql", () => {
  let adapter: MysqlAdapter;
  const cleanups: Array<() => Promise<unknown>> = [];
  const connect: typeof baseConnect = async (...args) => {
    const h = await baseConnect(...args);
    cleanups.push(() => h.close());
    return h;
  };

  beforeAll(async () => {
    const admin = await mysql.createConnection({ uri: url!, multipleStatements: true });
    await admin.query(`
      DROP VIEW IF EXISTS user_emails;
      DROP TABLE IF EXISTS posts, users, evil;
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(190) NOT NULL UNIQUE COMMENT 'Login address',
        name VARCHAR(100),
        meta JSON,
        created DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        big BIGINT,
        INDEX posts_user (user_id),
        CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE VIEW user_emails AS SELECT email FROM users;
    `);
    const values = Array.from({ length: 300 }, (_, i) => [`u${i + 1}@example.com`, `User ${i + 1}`, '{"n": 1}']);
    await admin.query("INSERT INTO users (email, name, meta) VALUES ?", [values]);
    await admin.query("INSERT INTO posts (user_id, title, big) VALUES (1, 'Hello', 9223372036854775807)");
    await admin.end();
    adapter = new MysqlAdapter({ url: url!, poolSize: 2 });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  });

  afterAll(async () => {
    const admin = await mysql.createConnection({ uri: url! });
    await admin.query("DROP TABLE IF EXISTS evil");
    await admin.end();
    await adapter?.close();
  });

  it("lists schemas and tables", async () => {
    const h = await connect(adapter);
    const dbName = new URL(url!).pathname.slice(1);
    expect((await h.call("list_schemas")).data.schemas).toContain(dbName);
    const tables = (await h.call("list_tables")).data.tables as Array<{ name: string; type: string }>;
    expect(tables.map((t) => `${t.name}:${t.type}`).sort()).toEqual(["posts:table", "user_emails:view", "users:table"]);
  });

  it("describes columns, indexes and foreign keys", async () => {
    const h = await connect(adapter);
    const users = (await h.call("describe_table", { table: "users" })).data;
    expect(users.columns.map((c: any) => c.name)).toEqual(["id", "email", "name", "meta", "created"]);
    expect(users.columns[0]).toMatchObject({ primaryKey: true, nullable: false });
    expect(users.columns.find((c: any) => c.name === "email")).toMatchObject({ comment: "Login address", nullable: false });
    expect(users.indexes.map((i: any) => i.name).sort()).toEqual(["PRIMARY", "email"]);

    const posts = (await h.call("describe_table", { table: "posts" })).data;
    expect(posts.foreignKeys[0]).toMatch(/fk_posts_user: FOREIGN KEY \(user_id\) REFERENCES .*users \(id\) ON DELETE CASCADE/);
    expect(posts.indexes.find((i: any) => i.name === "posts_user").columns).toEqual(["user_id"]);

    const missing = await h.call("describe_table", { table: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not found/);
  });

  it("runs parameterised queries and serialises types", async () => {
    const h = await connect(adapter);
    const { data } = await h.call("query", {
      sql: "SELECT u.id, u.email, u.meta, u.created, p.big FROM users u LEFT JOIN posts p ON p.user_id = u.id WHERE u.id = ?",
      params: [1],
    });
    expect(data.columns).toEqual(["id", "email", "meta", "created", "big"]);
    expect(data.rows[0][0]).toBe(1);
    expect(data.rows[0][2]).toEqual({ n: 1 });
    expect(data.rows[0][3]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.rows[0][4]).toBe("9223372036854775807");
  });

  it("keeps duplicate column names", async () => {
    const h = await connect(adapter);
    const { data } = await h.call("query", { sql: "SELECT u.id, p.id FROM users u JOIN posts p ON p.user_id = u.id" });
    expect(data.columns).toEqual(["id", "id"]);
    expect(data.rows).toEqual([[1, 1]]);
  });

  it("caps rows and reports truncation", async () => {
    const h = await connect(adapter, { maxRows: 50 });
    const { data } = await h.call("query", { sql: "SELECT * FROM users ORDER BY id" });
    expect(data.rowCount).toBe(50);
    expect(data.truncated).toBe(true);
  });

  it("does not mark a result with exactly maxRows rows as truncated", async () => {
    const res = await adapter.query("SELECT id FROM users ORDER BY id", [], { maxRows: 300, timeoutMs: 5000 });
    expect(res.rows).toHaveLength(300);
    expect(res.truncated).toBe(false);
  });

  it("stops reading a large result at the row cap and stops the query on the server", async () => {
    // 300^3 = 27 million rows: buffering them all would run into the timeout (or out of memory).
    const sql = "SELECT u1.id, u2.id, u3.id FROM users u1, users u2, users u3";
    const started = Date.now();
    const res = await adapter.query(sql, [], { maxRows: 50, timeoutMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.columns).toEqual(["id", "id", "id"]);
    expect(res.rows).toHaveLength(50);
    expect(res.truncated).toBe(true);

    // The connection was left mid-result: it must be closed, so the server stops sending rows.
    const admin = await mysql.createConnection({ uri: url! });
    try {
      let running: unknown[] = [];
      for (let i = 0; i < 40; i++) {
        [running] = (await admin.query("SELECT ID FROM information_schema.PROCESSLIST WHERE INFO = ?", [sql])) as [unknown[], unknown];
        if (running.length === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(running).toEqual([]);
    } finally {
      await admin.end();
    }

    // The pool keeps working and later queries are still read-only.
    for (let i = 0; i < 3; i++) {
      expect((await adapter.query("SELECT count(*) FROM users", [], { maxRows: 10, timeoutMs: 5000 })).rows).toEqual([[300]]);
    }
    await expect(adapter.query("DELETE FROM users WHERE id = 1", [], { maxRows: 10, timeoutMs: 5000 })).rejects.toThrow(/read.only/i);
  });

  it("samples rows", async () => {
    const h = await connect(adapter);
    expect((await h.call("sample_rows", { table: "users", limit: 5 })).data.rowCount).toBe(5);
  });

  it("is read-only at the database level even when the guard is bypassed", async () => {
    const limits = { maxRows: 10, timeoutMs: 5000 };
    await expect(adapter.query("DELETE FROM users WHERE id = 1", [], limits)).rejects.toThrow(/read.only/i);
    await expect(adapter.query("INSERT INTO users (email) VALUES ('x')", [], limits)).rejects.toThrow(/read.only/i);
    // DDL commits implicitly in MySQL; the session-level read-only default must still stop it.
    await expect(adapter.query("CREATE TABLE evil (a INT)", [], limits)).rejects.toThrow(/read.only/i);
    const [rows] = await (async () => {
      const admin = await mysql.createConnection({ uri: url! });
      try {
        return await admin.query("SHOW TABLES LIKE 'evil'");
      } finally {
        await admin.end();
      }
    })();
    expect(rows).toEqual([]);
    expect((await adapter.query("SELECT count(*) FROM users", [], limits)).rows[0]![0]).toBe(300);
  });

  it("rejects writes at the tool level", async () => {
    const h = await connect(adapter);
    for (const sql of ["DELETE FROM users WHERE id = 1", "SELECT 1; DROP TABLE users", "SELECT * INTO OUTFILE '/tmp/x' FROM users", "SELECT LOAD_FILE('/etc/passwd')"]) {
      expect((await h.call("query", { sql })).isError, sql).toBe(true);
    }
    expect(await h.toolNames()).not.toContain("execute");
  });

  it("applies the execution time limit", async () => {
    const started = Date.now();
    // MySQL interrupts SLEEP() at the limit and returns 1 (other statements raise ER_QUERY_TIMEOUT),
    // so assert on elapsed time rather than on an error.
    const res = await adapter.query("SELECT SLEEP(5) FROM users LIMIT 1", [], { maxRows: 10, timeoutMs: 300 }).catch(() => null);
    expect(Date.now() - started).toBeLessThan(3500);
    if (res) expect(res.durationMs).toBeLessThan(3500);
  });

  it("commits writes in read-write mode, rolls back failures, and stays writable after a read", async () => {
    const h = await connect(adapter, { allowWrites: true, allowDdl: true });
    // A read first, so that the pooled connection carries the read-only session default.
    await h.call("query", { sql: "SELECT 1" });

    const ins = await h.call("execute", { sql: "INSERT INTO users (email, name) VALUES (?, ?)", params: ["rw@example.com", "RW"] });
    expect(ins.isError).toBe(false);
    expect(ins.data.affectedRows).toBe(1);
    expect(ins.data.lastInsertId).toBeGreaterThan(0);

    const dup = await h.call("execute", { sql: "INSERT INTO users (email) VALUES (?)", params: ["rw@example.com"] });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/duplicate/i);

    const del = await h.call("execute", { sql: "DELETE FROM users WHERE email = ?", params: ["rw@example.com"] });
    expect(del.data.affectedRows).toBe(1);
    expect((await h.call("query", { sql: "SELECT count(*) FROM users" })).data.rows[0][0]).toBe(300);

    expect((await h.call("execute", { sql: "DELETE FROM users" })).isError).toBe(true);

    const ddl = await h.call("execute", { sql: "CREATE TABLE evil (a INT)" });
    expect(ddl.isError).toBe(false);
    await h.call("execute", { sql: "DROP TABLE evil" });
  });
});
