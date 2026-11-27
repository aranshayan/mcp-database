# Changelog

## 0.1.1

- Published from GitHub Actions with npm trusted publishing, so the package now carries a provenance statement linking it to this repository and commit. No code changes.

## 0.1.0

Initial release.

- PostgreSQL, MySQL/MariaDB and SQLite support behind one connection string.
- Tools: `list_schemas`, `list_tables`, `describe_table`, `sample_rows`, `query`, and (opt-in) `execute`.
- Read-only by default; SQL guard plus engine-level read-only enforcement.
- Row cap, statement timeout, parameterised queries, credential-scrubbed errors.

Also in this first release:

- SQLite queries now honour `--timeout-ms`. `query` and `sample_rows` run in a child process that is killed when the timeout passes, so a runaway statement no longer blocks the server. ([#2](https://github.com/aranshayan/mcp-database/issues/2))
