# db-compare

Interactive CLI for comparing MySQL schemas across two servers. Connects to both databases, lets you pick which schemas and tables to compare, and shows a structured diff of tables, columns, indexes, foreign keys, and triggers. Can also generate migration SQL to bring the target in line with the source.

## Install

```bash
git clone https://github.com/danielsharp01/db-compare
cd db-compare
npm install
npm link        # makes `db-compare` available globally
```

`npm link` runs `npm run build` automatically via the `prepare` script.

## Usage

```bash
db-compare --from "mysql://user:password@host" --to "mysql://user:password@host"
```

### Options

| Flag                  | Description                                      |
|-----------------------|--------------------------------------------------|
| `--from <uri>`        | Source database URI (required)                   |
| `--to <uri>`          | Target database URI (required)                   |
| `--indexes`           | Pre-select index comparison                      |
| `--triggers`          | Pre-select trigger comparison                    |
| `--ignoreIntegerWidth`| Pre-select "ignore integer display widths" option|
| `--help`              | Show usage                                       |

The URI format is `mysql://user:password@host[:port]`. The database name is omitted — schemas are always selected interactively.

### Example

```bash
db-compare \
  --from "mysql://root:root@localhost" \
  --to   "mysql://$PROD_USER:$PROD_PASS@$PROD_HOST" \
  --indexes
```

## Interactive flow

1. **Schema selection** — schemas present on both sides are listed and pre-selected; source-only / target-only schemas are noted.
2. **What to compare** — choose any combination of: tables, columns, indexes, foreign keys, triggers.
3. **Column checks** — if comparing columns, individually select which checks to run: missing columns, extra columns, type, nullable, default, extra attributes (e.g. `auto_increment`), charset, collation, comment.
4. **Integer width** — optionally ignore deprecated MySQL 8 display-width differences (`int(11)` vs `int`).
5. **Table filter** — optionally restrict comparison to specific tables.
6. **Results** — differences are printed grouped by object type with per-property detail.
7. **Migration SQL** — optionally generate SQL to migrate the target to match the source, saved to a file or printed to stdout.

## Output format

```
COLUMNS  (3)
  ──────────────────────────────────────────────
  ~ differs  `orders`.`status`
               type  to:varchar(20)  →  from:varchar(50)
  ✗ missing  `orders`.`archived_at`  [nullable]
  ＋ extra    `orders`.`legacy_ref`
```

The arrow reads as **current state → desired state**: `to:` is what the target has now, `from:` is what the source has (and what you want the target to become).

Destructive operations in the generated SQL are commented out with `--!` as a safety measure.

## Development

```bash
npm run build     # compile TypeScript → dist/
npm start         # run directly with tsx (no build needed)
```

Requires Node.js 18+ and `mysql2`-compatible MySQL/MariaDB servers.
