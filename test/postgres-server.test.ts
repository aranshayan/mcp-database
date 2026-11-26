import { afterAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "../src/adapters/postgres.js";

// Runs against a real PostgreSQL server when TEST_PG_URL is set, e.g.
//   TEST_PG_URL=postgres://postgres:test@127.0.0.1:5432/scratch npm test
// The main Postgres suite uses PGlite, which cannot interrupt a running statement,
// so the enforcement of statement_timeout is only checked here.
const url = process.env.TEST_PG_URL;
const suite = url ? describe : describe.skip;

suite("postgres server", () => {
  const adapter = url ? new PostgresAdapter({ url, poolSize: 2 }) : null!;
  afterAll(async () => adapter?.close());

  it("cancels a statement that runs past the timeout", async () => {
    const started = Date.now();
    await expect(adapter.query("SELECT pg_sleep(5)", [], { maxRows: 10, timeoutMs: 300 })).rejects.toThrow(/statement timeout/i);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("keeps serving queries after a cancelled statement", async () => {
    await adapter.query("SELECT pg_sleep(5)", [], { maxRows: 10, timeoutMs: 200 }).catch(() => {});
    const res = await adapter.query("SELECT 1 + 1", [], { maxRows: 10, timeoutMs: 5000 });
    expect(res.rows).toEqual([[2]]);
  });

  it("refuses writes at the engine level even without the SQL guard", async () => {
    await expect(adapter.query("CREATE TABLE should_not_exist (id int)", [], { maxRows: 10, timeoutMs: 5000 })).rejects.toThrow(/read-only transaction/i);
  });
});
