# mcp-database

[![CI](https://github.com/aranshayan/mcp-database/actions/workflows/ci.yml/badge.svg)](https://github.com/aranshayan/mcp-database/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@aranshayan/mcp-database)](https://www.npmjs.com/package/@aranshayan/mcp-database)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A **safe-by-default [Model Context Protocol](https://modelcontextprotocol.io) server for PostgreSQL, MySQL/MariaDB and SQLite.**
Let Claude (or any MCP client) explore your schema and answer questions from your data — without handing it a loaded gun.

- **Read-only by default.** Writes need an explicit `--read-write` flag, and the `execute` tool does not even exist until you pass it.
- **Defence in depth.** Every query is checked by a SQL guard *and* runs inside a read-only transaction / read-only connection, so a guard bypass still cannot write.
- **Built for LLMs.** Schema discovery tools, parameterised queries, row caps, statement timeouts, compact JSON output, errors that explain what to do next.
- **Zero native dependencies.** SQLite uses Node's built-in `node:sqlite`; Postgres and MySQL use pure-JS drivers. `npx` just works.
- **One server, three engines.** The connection string decides the dialect.

> **Only PostgreSQL, with personal data in it?** [pg-guard-mcp](https://github.com/aranshayan/pg-guard-mcp) is the stricter sibling: Postgres only, never writes, masks the columns you mark as personal data and keeps an append-only audit log.

## Quick start

Use a database account that can only `SELECT` (see [Create a read-only role](#create-a-read-only-role)).

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": ["-y", "@aranshayan/mcp-database"],
      "env": { "DATABASE_URL": "postgres://readonly:secret@localhost:5432/mydb" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add database --env DATABASE_URL=postgres://readonly:secret@localhost:5432/mydb -- npx -y @aranshayan/mcp-database
```

**Cursor / VS Code / any MCP client:** run `npx -y @aranshayan/mcp-database` as a stdio server with `DATABASE_URL` in its environment.

| Engine | `DATABASE_URL` |
| --- | --- |
| PostgreSQL | `postgres://user:pass@host:5432/db` |
| MySQL / MariaDB | `mysql://user:pass@host:3306/db` |
| SQLite | `sqlite:///absolute/path/app.db` or just `./app.db` |

Requires **Node.js 22.13+**.

## Tools

| Tool | What it does |
| --- | --- |
| `list_schemas` | Schemas / databases on the connection. |
| `list_tables` | Tables and views with type and estimated row count. |
| `describe_table` | Columns (type, nullability, default, primary key, comment), indexes, foreign keys. |
| `sample_rows` | Preview the first 1–100 rows of a table. |
| `query` | Run **one** read-only statement (`SELECT` / `WITH` / `VALUES` / `SHOW` / `EXPLAIN`) with `params`. |
| `execute` | *Only with `--read-write`.* Run **one** `INSERT` / `UPDATE` / `DELETE` in a transaction. |

All read tools are annotated `readOnlyHint`; `execute` is annotated `destructiveHint` so clients can ask for confirmation.

## Options

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| *(url)* / `--url` | `DATABASE_URL` | — | Connection string. Prefer the environment variable: command-line arguments are visible in process lists. |
| `--read-write` | `MCP_DATABASE_READ_WRITE=1` | off | Enables `execute`. |
| `--allow-ddl` | `MCP_DATABASE_ALLOW_DDL=1` | off | With `--read-write`, also permit `CREATE` / `ALTER` / `DROP` / `TRUNCATE`. |
| `--max-rows <n>` | `MCP_DATABASE_MAX_ROWS` | 200 | Rows returned per query (max 5000). |
| `--timeout-ms <n>` | `MCP_DATABASE_TIMEOUT_MS` | 15000 | Statement timeout. |

## Safety model

Three independent layers, so no single bug is fatal:

1. **SQL guard** (`src/sql-guard.ts`). Comments, string literals and quoted identifiers are stripped per dialect (MySQL `#` and `--␠` comments, PostgreSQL dollar-quoting and nested comments, SQLite `[brackets]`…), then the statement must be a *single* statement of an allowed kind. Rejected outright: multiple statements, `COPY`, `CALL`, `SET`, `ATTACH`, `SELECT … INTO OUTFILE`, `LOAD_FILE()`, `pg_read_file()`, `load_extension()`, SQLite `PRAGMA` assignment, MySQL `/*! … */` executable comments, and more. `UPDATE` / `DELETE` without `WHERE` is refused in read-write mode.
2. **Engine-level read-only.**
   - PostgreSQL: `BEGIN READ ONLY` + `SET LOCAL statement_timeout`, results streamed through a cursor.
   - MySQL: `SET SESSION TRANSACTION READ ONLY` + `START TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME`. (The session-level setting matters: MySQL DDL commits implicitly and would otherwise escape a plain read-only transaction. This is covered by a test.)
   - SQLite: the file is opened `readOnly` and `PRAGMA query_only = ON`. Queries run in a separate process with its own read-only connection, which is killed when the statement timeout passes.
3. **Your database account.** The guard and read-only mode are defences, not a substitute for least privilege. Connect with a role that can only read what the model should see.

Errors are scrubbed of the connection string and password before they reach the model, and the server never logs to stdout (reserved for the protocol).

### Create a read-only role

```sql
-- PostgreSQL
CREATE ROLE mcp_readonly LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE mydb TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;

-- MySQL
CREATE USER 'mcp_readonly'@'%' IDENTIFIED BY 'change-me';
GRANT SELECT ON mydb.* TO 'mcp_readonly'@'%';
```

## Known limits

- **SQLite timeouts stop the query process.** `node:sqlite` cannot interrupt a statement, so `query` and `sample_rows` run in a child process that is killed (SIGKILL) at `--timeout-ms` and restarted for the next query. The schema tools and `execute` run in the server process without a timeout; they are short metadata reads or single writes. An in-memory database (`:memory:`) only exists inside the server process, so its queries have no timeout.
- **MySQL buffers a result set before the row cap is applied** (`mysql2` has no server-side cursor). Keep a `LIMIT` in large queries. `MAX_EXECUTION_TIME` bounds time.
- Only the first statement type is classified; the engine-level read-only layer is what ultimately prevents writes through exotic constructs.
- `EXPLAIN ANALYZE` actually executes the statement. It is classified by the statement it wraps, and in read-only mode a wrapped write is rejected.

## What is tested

`npm test` runs 100+ tests, including:

- the SQL guard against comment/string/dollar-quote smuggling tricks, per dialect;
- **SQLite** through `node:sqlite`, including a runaway recursive CTE that is stopped at the timeout and its process killed;
- **PostgreSQL** against a real Postgres engine ([PGlite](https://pglite.dev) behind a TCP socket) through the real `pg` driver, including cursors;
- **MySQL and MariaDB** against real servers. CI runs the suite on MySQL 8.4, MySQL 9 and MariaDB 11; locally, set `TEST_MYSQL_URL` to a scratch database (skipped otherwise);
- **PostgreSQL `statement_timeout` enforcement** against a real PostgreSQL 17 server in CI (`TEST_PG_URL` locally), including that the pool keeps working after a cancelled statement;
- the **built CLI over stdio**, exactly as an MCP client launches it.

MariaDB-specific code paths (`max_statement_time`, schemas without `STATISTICS.EXPRESSION`) now run in CI through the MariaDB 11 job.

## Development

```bash
npm install
npm test            # unit + integration + e2e
npm run typecheck
npm run build       # bundles to dist/index.js

# optional: also run the server suites against scratch databases
TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/scratch TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/scratch npm test
```

## License

[MIT](LICENSE)
