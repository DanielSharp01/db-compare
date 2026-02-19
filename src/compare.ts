import type {
  TableDef,
  ColumnDef,
  IndexDef,
  TriggerDef,
  ForeignKeyDef,
} from "./mysql.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Severity = "missing" | "extra" | "diff";

export interface PropertyDiff {
  prop: string; // friendly name e.g. "nullable"
  source: string;
  target: string;
}

export interface Difference {
  severity: Severity;
  object: "table" | "column" | "index" | "trigger" | "foreignKey";
  table?: string;
  name: string;
  detail: string;
  properties?: PropertyDiff[]; // structured diffs for "diff" severity entries
}

export interface CompareResult {
  differences: Difference[];
  sourceSchema: string;
  targetSchema: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapByKey<T>(arr: T[], key: keyof T): Map<string, T> {
  return new Map(arr.map((item) => [String(item[key]), item]));
}

const COLUMN_PROP_MAP: Record<string, string> = {
  type: "columnType",
  nullable: "isNullable",
  default: "columnDefault",
  extra: "extra",
  charset: "characterSetName",
  collation: "collationName",
  comment: "columnComment",
};

export const ALL_COLUMN_PROPERTIES = Object.keys(COLUMN_PROP_MAP);

/**
 * Strip deprecated integer display widths that MySQL 8 ignores.
 * e.g. int(11) → int, tinyint(1) → tinyint, bigint(20) → bigint
 */
function normalizeIntegerWidth(colType: string): string {
  return colType.replace(
    /^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/i,
    "$1",
  );
}

// ── Tables ────────────────────────────────────────────────────────────────────

function compareTables(
  source: TableDef[],
  target: TableDef[],
  diffs: Difference[],
): void {
  const srcMap = mapByKey(source, "name");
  const tgtMap = mapByKey(target, "name");

  for (const [name] of srcMap) {
    if (!tgtMap.has(name)) {
      diffs.push({
        severity: "missing",
        object: "table",
        name,
        detail: `Table \`${name}\` exists in source but not in target`,
      });
    }
  }

  for (const [name] of tgtMap) {
    if (!srcMap.has(name)) {
      diffs.push({
        severity: "extra",
        object: "table",
        name,
        detail: `Table \`${name}\` exists in target but not in source`,
      });
    }
  }
}

// ── Columns ───────────────────────────────────────────────────────────────────

function compareColumns(
  sourceColumns: ColumnDef[],
  targetColumns: ColumnDef[],
  sourceTables: TableDef[],
  targetTables: TableDef[],
  diffs: Difference[],
  tableFilter?: string[],
  columnProperties?: string[],
  ignoreIntegerWidth?: boolean,
  includeMissingColumns?: boolean,
  includeExtraColumns?: boolean,
): void {
  const srcTableNames = new Set(sourceTables.map((t) => t.name));
  const tgtTableNames = new Set(targetTables.map((t) => t.name));
  const commonTables = [...srcTableNames].filter((n) => tgtTableNames.has(n));
  const filteredTables =
    tableFilter && tableFilter.length > 0
      ? commonTables.filter((t) => tableFilter.includes(t))
      : commonTables;

  // Group columns by table
  const srcByTable = new Map<string, Map<string, ColumnDef>>();
  const tgtByTable = new Map<string, Map<string, ColumnDef>>();

  for (const col of sourceColumns) {
    if (!srcByTable.has(col.table)) srcByTable.set(col.table, new Map());
    srcByTable.get(col.table)!.set(col.name, col);
  }
  for (const col of targetColumns) {
    if (!tgtByTable.has(col.table)) tgtByTable.set(col.table, new Map());
    tgtByTable.get(col.table)!.set(col.name, col);
  }

  for (const tableName of filteredTables) {
    const srcCols = srcByTable.get(tableName) ?? new Map<string, ColumnDef>();
    const tgtCols = tgtByTable.get(tableName) ?? new Map<string, ColumnDef>();

    for (const [colName, srcCol] of srcCols) {
      if (!tgtCols.has(colName)) {
        if (includeMissingColumns !== false) {
          diffs.push({
            severity: "missing",
            object: "column",
            table: tableName,
            name: colName,
            detail: `Column \`${tableName}\`.\`${colName}\` (${srcCol.columnType}) missing in target`,
          });
        }
      } else {
        const tgtCol = tgtCols.get(colName)!;
        const properties: PropertyDiff[] = [];
        const propsToCheck = columnProperties ?? ALL_COLUMN_PROPERTIES;

        for (const friendlyName of propsToCheck) {
          const sigKey = COLUMN_PROP_MAP[friendlyName];
          if (!sigKey) continue;
          let srcVal = String(
            (srcCol as unknown as Record<string, unknown>)[sigKey] ?? "NULL",
          );
          let tgtVal = String(
            (tgtCol as unknown as Record<string, unknown>)[sigKey] ?? "NULL",
          );
          // Optionally ignore integer display widths (deprecated in MySQL 8)
          if (ignoreIntegerWidth && friendlyName === "type") {
            srcVal = normalizeIntegerWidth(srcVal);
            tgtVal = normalizeIntegerWidth(tgtVal);
          }
          if (srcVal !== tgtVal) {
            properties.push({
              prop: friendlyName,
              source: srcVal,
              target: tgtVal,
            });
          }
        }

        if (properties.length > 0) {
          diffs.push({
            severity: "diff",
            object: "column",
            table: tableName,
            name: colName,
            detail: `\`${tableName}\`.\`${colName}\``,
            properties,
          });
        }
      }
    }

    for (const [colName] of tgtCols) {
      if (!srcCols.has(colName)) {
        if (includeExtraColumns !== false) {
          const tgtCol = tgtCols.get(colName)!;
          const nullable = tgtCol.isNullable === "YES";
          const hasDefault = tgtCol.columnDefault !== null;
          const compat: string[] = [];
          if (nullable) compat.push("nullable");
          if (hasDefault) compat.push(`default=${tgtCol.columnDefault}`);
          const compatNote =
            compat.length > 0
              ? ` [${compat.join(", ")}]`
              : ` [NOT NULL, no default — adding this column will fail if table has rows]`;
          diffs.push({
            severity: "extra",
            object: "column",
            table: tableName,
            name: colName,
            detail: `Column \`${tableName}\`.\`${colName}\` (${tgtCol.columnType})${compatNote} exists in target but not in source`,
          });
        }
      }
    }
  }
}

// ── Indexes ───────────────────────────────────────────────────────────────────

// Key: table + "." + indexName + "." + seqInIndex
function compareIndexes(
  sourceIndexes: IndexDef[],
  targetIndexes: IndexDef[],
  sourceTables: TableDef[],
  targetTables: TableDef[],
  diffs: Difference[],
): void {
  const srcTableNames = new Set(sourceTables.map((t) => t.name));
  const tgtTableNames = new Set(targetTables.map((t) => t.name));
  const commonTables = [...srcTableNames].filter((n) => tgtTableNames.has(n));

  // Build per-table index structures: { indexName -> IndexDef[] (ordered by seqInIndex) }
  type IndexMap = Map<string, IndexDef[]>;
  const srcByTable = new Map<string, IndexMap>();
  const tgtByTable = new Map<string, IndexMap>();

  function addToMap(map: Map<string, IndexMap>, idx: IndexDef) {
    if (!map.has(idx.table)) map.set(idx.table, new Map());
    const tmap = map.get(idx.table)!;
    if (!tmap.has(idx.indexName)) tmap.set(idx.indexName, []);
    tmap.get(idx.indexName)!.push(idx);
  }

  sourceIndexes.forEach((i) => addToMap(srcByTable, i));
  targetIndexes.forEach((i) => addToMap(tgtByTable, i));

  for (const tableName of commonTables) {
    const srcIdxMap =
      srcByTable.get(tableName) ?? new Map<string, IndexDef[]>();
    const tgtIdxMap =
      tgtByTable.get(tableName) ?? new Map<string, IndexDef[]>();

    for (const [idxName, srcParts] of srcIdxMap) {
      if (!tgtIdxMap.has(idxName)) {
        const cols = srcParts.map((p) => p.columnName).join(", ");
        diffs.push({
          severity: "missing",
          object: "index",
          table: tableName,
          name: idxName,
          detail: `Index \`${idxName}\` on \`${tableName}\` (${cols}) missing in target`,
        });
      } else {
        const tgtParts = tgtIdxMap.get(idxName)!;
        const srcCols = srcParts.map((p) => p.columnName).join(",");
        const tgtCols = tgtParts.map((p) => p.columnName).join(",");
        const srcUnique = srcParts[0]?.nonUnique === 0;
        const tgtUnique = tgtParts[0]?.nonUnique === 0;
        const srcType = srcParts[0]?.indexType;
        const tgtType = tgtParts[0]?.indexType;

        const propDiffs: string[] = [];
        if (srcCols !== tgtCols)
          propDiffs.push(`columns: source="${srcCols}" vs target="${tgtCols}"`);
        if (srcUnique !== tgtUnique)
          propDiffs.push(`unique: source=${srcUnique} vs target=${tgtUnique}`);
        if (srcType !== tgtType)
          propDiffs.push(`type: source="${srcType}" vs target="${tgtType}"`);

        if (propDiffs.length > 0) {
          diffs.push({
            severity: "diff",
            object: "index",
            table: tableName,
            name: idxName,
            detail:
              `Index \`${idxName}\` on \`${tableName}\` differs:\n` +
              propDiffs.map((d) => `  • ${d}`).join("\n"),
          });
        }
      }
    }

    for (const [idxName] of tgtIdxMap) {
      if (!srcIdxMap.has(idxName)) {
        const parts = tgtIdxMap.get(idxName)!;
        const cols = parts.map((p) => p.columnName).join(", ");
        diffs.push({
          severity: "extra",
          object: "index",
          table: tableName,
          name: idxName,
          detail: `Index \`${idxName}\` on \`${tableName}\` (${cols}) exists in target but not in source`,
        });
      }
    }
  }
}

// ── Foreign Keys ─────────────────────────────────────────────────────────────

function compareForeignKeys(
  sourceFKs: ForeignKeyDef[],
  targetFKs: ForeignKeyDef[],
  sourceTables: TableDef[],
  targetTables: TableDef[],
  diffs: Difference[],
): void {
  const srcTableNames = new Set(sourceTables.map((t) => t.name));
  const tgtTableNames = new Set(targetTables.map((t) => t.name));
  const commonTables = [...srcTableNames].filter((n) => tgtTableNames.has(n));

  // Key: table + "." + constraintName (FK names are unique per schema but scope to table for clarity)
  const srcMap = new Map(
    sourceFKs
      .filter((f) => commonTables.includes(f.table))
      .map((f) => [`${f.table}.${f.name}`, f]),
  );
  const tgtMap = new Map(
    targetFKs
      .filter((f) => commonTables.includes(f.table))
      .map((f) => [`${f.table}.${f.name}`, f]),
  );

  for (const [key, src] of srcMap) {
    if (!tgtMap.has(key)) {
      diffs.push({
        severity: "missing",
        object: "foreignKey",
        table: src.table,
        name: src.name,
        detail: `FK \`${src.name}\` on \`${src.table}\`(${src.columns}) → \`${src.refTable}\`(${src.refColumns}) missing in target`,
      });
    } else {
      const tgt = tgtMap.get(key)!;
      const propDiffs: string[] = [];
      if (src.columns !== tgt.columns)
        propDiffs.push(
          `columns: source="${src.columns}" vs target="${tgt.columns}"`,
        );
      if (src.refTable !== tgt.refTable)
        propDiffs.push(
          `refTable: source="${src.refTable}" vs target="${tgt.refTable}"`,
        );
      if (src.refColumns !== tgt.refColumns)
        propDiffs.push(
          `refColumns: source="${src.refColumns}" vs target="${tgt.refColumns}"`,
        );
      if (src.onUpdate !== tgt.onUpdate)
        propDiffs.push(
          `ON UPDATE: source="${src.onUpdate}" vs target="${tgt.onUpdate}"`,
        );
      if (src.onDelete !== tgt.onDelete)
        propDiffs.push(
          `ON DELETE: source="${src.onDelete}" vs target="${tgt.onDelete}"`,
        );

      if (propDiffs.length > 0) {
        diffs.push({
          severity: "diff",
          object: "foreignKey",
          table: src.table,
          name: src.name,
          detail:
            `FK \`${src.name}\` on \`${src.table}\` differs:\n` +
            propDiffs.map((d) => `  • ${d}`).join("\n"),
        });
      }
    }
  }

  for (const [key, tgt] of tgtMap) {
    if (!srcMap.has(key)) {
      diffs.push({
        severity: "extra",
        object: "foreignKey",
        table: tgt.table,
        name: tgt.name,
        detail: `FK \`${tgt.name}\` on \`${tgt.table}\`(${tgt.columns}) → \`${tgt.refTable}\`(${tgt.refColumns}) exists in target but not in source`,
      });
    }
  }
}

// ── Triggers ──────────────────────────────────────────────────────────────────

function compareTriggers(
  sourceTriggers: TriggerDef[],
  targetTriggers: TriggerDef[],
  diffs: Difference[],
): void {
  const srcMap = mapByKey(sourceTriggers, "name");
  const tgtMap = mapByKey(targetTriggers, "name");

  for (const [name, src] of srcMap) {
    if (!tgtMap.has(name)) {
      diffs.push({
        severity: "missing",
        object: "trigger",
        name,
        table: src.table,
        detail: `Trigger \`${name}\` (${src.timing} ${src.event} on \`${src.table}\`) missing in target`,
      });
    } else {
      const tgt = tgtMap.get(name)!;
      const propDiffs: string[] = [];

      if (src.event !== tgt.event)
        propDiffs.push(`event: source="${src.event}" vs target="${tgt.event}"`);
      if (src.timing !== tgt.timing)
        propDiffs.push(
          `timing: source="${src.timing}" vs target="${tgt.timing}"`,
        );
      if (src.table !== tgt.table)
        propDiffs.push(`table: source="${src.table}" vs target="${tgt.table}"`);
      // Normalize whitespace for body comparison
      const normalizeBody = (s: string) => s.replace(/\s+/g, " ").trim();
      if (normalizeBody(src.statement) !== normalizeBody(tgt.statement))
        propDiffs.push(`body differs`);

      if (propDiffs.length > 0) {
        diffs.push({
          severity: "diff",
          object: "trigger",
          name,
          table: src.table,
          detail:
            `Trigger \`${name}\` differs:\n` +
            propDiffs.map((d) => `  • ${d}`).join("\n"),
        });
      }
    }
  }

  for (const [name, tgt] of tgtMap) {
    if (!srcMap.has(name)) {
      diffs.push({
        severity: "extra",
        object: "trigger",
        name,
        table: tgt.table,
        detail: `Trigger \`${name}\` (${tgt.timing} ${tgt.event} on \`${tgt.table}\`) exists in target but not in source`,
      });
    }
  }
}

// ── Main compare ──────────────────────────────────────────────────────────────

export interface CompareOptions {
  includeTables: boolean;
  includeColumns: boolean;
  columnProperties?: string[]; // friendly names to compare; undefined = all
  includeMissingColumns?: boolean; // default true
  includeExtraColumns?: boolean; // default true
  ignoreIntegerWidth?: boolean; // ignore int(11) vs int etc.
  includeIndexes: boolean;
  includeForeignKeys: boolean;
  includeTriggers: boolean;
  tableFilter?: string[]; // if set, only compare these tables
}

export interface SchemaData {
  schema: string;
  tables: TableDef[];
  columns: ColumnDef[];
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  triggers: TriggerDef[];
}

export function compareSchemas(
  source: SchemaData,
  target: SchemaData,
  opts: CompareOptions,
): CompareResult {
  const diffs: Difference[] = [];

  if (opts.includeTables) {
    compareTables(source.tables, target.tables, diffs);
  }

  if (opts.includeColumns) {
    compareColumns(
      source.columns,
      target.columns,
      source.tables,
      target.tables,
      diffs,
      opts.tableFilter,
      opts.columnProperties,
      opts.ignoreIntegerWidth,
      opts.includeMissingColumns,
      opts.includeExtraColumns,
    );
  }

  if (opts.includeIndexes) {
    compareIndexes(
      source.indexes,
      target.indexes,
      source.tables,
      target.tables,
      diffs,
    );
  }

  if (opts.includeForeignKeys) {
    compareForeignKeys(
      source.foreignKeys,
      target.foreignKeys,
      source.tables,
      target.tables,
      diffs,
    );
  }

  if (opts.includeTriggers) {
    compareTriggers(source.triggers, target.triggers, diffs);
  }

  return {
    differences: diffs,
    sourceSchema: source.schema,
    targetSchema: target.schema,
  };
}
