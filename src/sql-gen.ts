import type { ColumnDef, IndexDef, ForeignKeyDef } from "./mysql.js";
import type { CompareResult, SchemaData } from "./compare.js";

// ── Quoting helpers ───────────────────────────────────────────────────────────

function escId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function formatDefaultValue(val: string): string {
  // MySQL 8 wraps generated expressions in parens
  if (val.startsWith("(")) return val;
  // Known bare functions / keywords
  if (/^[A-Za-z_]+\s*\(/.test(val)) return val;
  if (/^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NULL)$/i.test(val))
    return val;
  // Pure integer or decimal
  if (/^-?\d+(\.\d+)?$/.test(val)) return val;
  // String literal — wrap in single quotes
  return `'${val.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// ── Column definition builder ─────────────────────────────────────────────────

function buildColumnDef(col: ColumnDef): string {
  const parts: string[] = [escId(col.name), col.columnType];

  if (col.characterSetName) parts.push(`CHARACTER SET ${col.characterSetName}`);
  if (col.collationName) parts.push(`COLLATE ${col.collationName}`);

  parts.push(col.isNullable === "YES" ? "NULL" : "NOT NULL");

  if (col.columnDefault !== null) {
    parts.push(`DEFAULT ${formatDefaultValue(col.columnDefault)}`);
  }

  if (col.extra) parts.push(col.extra);

  if (col.columnComment) {
    parts.push(`COMMENT '${col.columnComment.replace(/'/g, "\\'")}'`);
  }

  return parts.join(" ");
}

// ── Index clause builder ──────────────────────────────────────────────────────

function buildIndexClause(parts: IndexDef[]): string {
  const cols = parts
    .sort((a, b) => a.seqInIndex - b.seqInIndex)
    .map((p) => escId(p.columnName))
    .join(", ");
  const name = parts[0].indexName;
  const type = parts[0].indexType;
  const unique = parts[0].nonUnique === 0 ? "UNIQUE " : "";
  const using = type !== "BTREE" ? ` USING ${type}` : "";
  return `${unique}INDEX ${escId(name)} (${cols})${using}`;
}

// ── FK clause builder ─────────────────────────────────────────────────────────

function buildFKClause(fk: ForeignKeyDef): string {
  const cols = fk.columns
    .split(",")
    .map((c) => escId(c.trim()))
    .join(", ");
  const refCols = fk.refColumns
    .split(",")
    .map((c) => escId(c.trim()))
    .join(", ");
  return (
    `CONSTRAINT ${escId(fk.name)} FOREIGN KEY (${cols}) ` +
    `REFERENCES ${escId(fk.refTable)} (${refCols}) ` +
    `ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`
  );
}

// ── CREATE TABLE builder ──────────────────────────────────────────────────────

function buildCreateTable(tableName: string, source: SchemaData): string {
  const cols = source.columns
    .filter((c) => c.table === tableName)
    .sort((a, b) => a.ordinalPosition - b.ordinalPosition);

  if (cols.length === 0) {
    return `-- CREATE TABLE ${escId(tableName)}; -- (no column data available)\n`;
  }

  const pkCols = cols
    .filter((c) => c.columnKey === "PRI")
    .map((c) => escId(c.name));

  const lines: string[] = cols.map((col) => `  ${buildColumnDef(col)}`);
  if (pkCols.length > 0) {
    lines.push(`  PRIMARY KEY (${pkCols.join(", ")})`);
  }

  return `CREATE TABLE ${escId(tableName)} (\n` + lines.join(",\n") + `\n);\n`;
}

// ── Main generator ────────────────────────────────────────────────────────────

export function generateMigrationSQL(
  result: CompareResult,
  source: SchemaData,
): string {
  const { differences, sourceSchema, targetSchema } = result;

  if (differences.length === 0) return "";

  const out: string[] = [];

  const line = (s = "") => out.push(s);
  const divider = (title: string) =>
    line(`-- ─── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);

  line(`-- ${"═".repeat(68)}`);
  line(`-- Migration: ${sourceSchema} (source) → ${targetSchema} (target)`);
  line(`-- Generated: ${new Date().toISOString()}`);
  line(`--`);
  line(`-- Apply to TARGET to make it match SOURCE.`);
  line(`-- Lines prefixed with "--!" are destructive and commented out by`);
  line(`-- default. Uncomment after careful review.`);
  line(`-- FK/index ordering may need manual adjustment.`);
  line(`-- ${"═".repeat(68)}`);
  line();
  line(`USE ${escId(targetSchema)};`);
  line();

  // ── Missing / extra tables ─────────────────────────────────────────────────

  const missingTables = differences
    .filter((d) => d.object === "table" && d.severity === "missing")
    .map((d) => d.name)
    .sort();

  const extraTables = differences
    .filter((d) => d.object === "table" && d.severity === "extra")
    .map((d) => d.name)
    .sort();

  if (missingTables.length > 0) {
    divider("Create missing tables");
    line();
    for (const tbl of missingTables) {
      line(`-- Table \`${tbl}\` is missing in target`);
      line(buildCreateTable(tbl, source));
    }
  }

  if (extraTables.length > 0) {
    divider("Drop extra tables (destructive — commented out)");
    line();
    for (const tbl of extraTables) {
      line(`--! DROP TABLE ${escId(tbl)};  -- exists in target only`);
    }
    line();
  }

  // ── Per-table alterations ──────────────────────────────────────────────────

  // Gather all tables that have column / index / FK diffs
  const tablesWithDiffs = [
    ...new Set(
      differences
        .filter(
          (d) => d.table && d.object !== "table" && d.object !== "trigger",
        )
        .map((d) => d.table!),
    ),
  ].sort();

  for (const tableName of tablesWithDiffs) {
    const tableDiffs = differences.filter((d) => d.table === tableName);

    // Collect ALTER TABLE clauses in the correct order:
    //   1. DROP FOREIGN KEY  (destructive → commented)
    //   2. DROP INDEX        (destructive → commented)
    //   3. DROP COLUMN       (destructive → commented)
    //   4. ADD COLUMN
    //   5. MODIFY COLUMN
    //   6. ADD INDEX
    //   7. ADD CONSTRAINT FK

    const dropFKClauses: string[] = [];
    const dropIdxClauses: string[] = [];
    const dropColClauses: string[] = [];
    const addColClauses: string[] = [];
    const modifyColClauses: string[] = [];
    const addIdxClauses: string[] = [];
    const addFKClauses: string[] = [];

    for (const d of tableDiffs) {
      // ── columns ────────────────────────────────────────────────────────────
      if (d.object === "column") {
        if (d.severity === "missing") {
          const col = source.columns.find(
            (c) => c.table === tableName && c.name === d.name,
          );
          if (col) {
            addColClauses.push(
              `  -- Add: \`${d.name}\`\n  ADD COLUMN ${buildColumnDef(col)}`,
            );
          }
        } else if (d.severity === "extra") {
          dropColClauses.push(
            `  --! DROP COLUMN ${escId(d.name)}  -- WARNING: data loss`,
          );
        } else if (d.severity === "diff" && d.properties) {
          const col = source.columns.find(
            (c) => c.table === tableName && c.name === d.name,
          );
          if (col) {
            const diffLines = d.properties
              .map((p) => `  --   ${p.prop}: ${p.source} → ${p.target}`)
              .join("\n");
            modifyColClauses.push(
              `  -- Modify: \`${d.name}\` (${d.properties.map((p) => p.prop).join(", ")})\n` +
                diffLines +
                `\n  MODIFY COLUMN ${buildColumnDef(col)}`,
            );
          }
        }
      }

      // ── indexes ────────────────────────────────────────────────────────────
      else if (d.object === "index" && d.name !== "PRIMARY") {
        if (d.severity === "missing") {
          const parts = source.indexes
            .filter((i) => i.table === tableName && i.indexName === d.name)
            .sort((a, b) => a.seqInIndex - b.seqInIndex);
          if (parts.length > 0) {
            addIdxClauses.push(
              `  -- Add index: \`${d.name}\`\n  ADD ${buildIndexClause(parts)}`,
            );
          }
        } else if (d.severity === "extra") {
          dropIdxClauses.push(
            `  --! DROP INDEX ${escId(d.name)}  -- exists in target only`,
          );
        } else if (d.severity === "diff") {
          dropIdxClauses.push(
            `  --! DROP INDEX ${escId(d.name)}  -- will be re-added below`,
          );
          const parts = source.indexes
            .filter((i) => i.table === tableName && i.indexName === d.name)
            .sort((a, b) => a.seqInIndex - b.seqInIndex);
          if (parts.length > 0) {
            addIdxClauses.push(
              `  -- Re-add changed index: \`${d.name}\`\n  ADD ${buildIndexClause(parts)}`,
            );
          }
        }
      }

      // ── foreign keys ───────────────────────────────────────────────────────
      else if (d.object === "foreignKey") {
        if (d.severity === "missing") {
          const fk = source.foreignKeys.find(
            (f) => f.table === tableName && f.name === d.name,
          );
          if (fk) {
            addFKClauses.push(
              `  -- Add FK: \`${d.name}\`\n  ADD ${buildFKClause(fk)}`,
            );
          }
        } else if (d.severity === "extra") {
          dropFKClauses.push(
            `  --! DROP FOREIGN KEY ${escId(d.name)}  -- exists in target only`,
          );
        } else if (d.severity === "diff") {
          dropFKClauses.push(
            `  --! DROP FOREIGN KEY ${escId(d.name)}  -- will be re-added below`,
          );
          const fk = source.foreignKeys.find(
            (f) => f.table === tableName && f.name === d.name,
          );
          if (fk) {
            addFKClauses.push(
              `  -- Re-add changed FK: \`${d.name}\`\n  ADD ${buildFKClause(fk)}`,
            );
          }
        }
      }
    }

    const allClauses = [
      ...dropFKClauses,
      ...dropIdxClauses,
      ...dropColClauses,
      ...addColClauses,
      ...modifyColClauses,
      ...addIdxClauses,
      ...addFKClauses,
    ];

    if (allClauses.length === 0) continue;

    divider(`Table: ${tableName}`);
    line();
    line(`ALTER TABLE ${escId(tableName)}`);
    line(allClauses.join(",\n"));
    line(`;`);
    line();
  }

  // ── Triggers ───────────────────────────────────────────────────────────────

  const triggerDiffs = differences.filter((d) => d.object === "trigger");

  if (triggerDiffs.length > 0) {
    divider("Triggers");
    line();

    for (const d of triggerDiffs) {
      if (d.severity === "missing" || d.severity === "diff") {
        if (d.severity === "diff") {
          line(`-- Drop changed trigger (re-create below)`);
          line(`DROP TRIGGER IF EXISTS ${escId(d.name)};`);
        } else {
          line(`-- Create missing trigger`);
        }
        const trig = source.triggers.find((t) => t.name === d.name);
        if (trig) {
          line(
            `CREATE TRIGGER ${escId(trig.name)} ${trig.timing} ${trig.event}` +
              ` ON ${escId(trig.table)} FOR EACH ROW`,
          );
          line(trig.statement + ";");
        }
        line();
      } else if (d.severity === "extra") {
        line(`-- Drop extra trigger`);
        line(`DROP TRIGGER IF EXISTS ${escId(d.name)};`);
        line();
      }
    }
  }

  return out.join("\n");
}
