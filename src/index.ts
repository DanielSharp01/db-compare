#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import {
  connect,
  listDatabases,
  getTables,
  getColumns,
  getIndexes,
  getForeignKeys,
  getTriggers,
  type Connection,
  type ConnectionConfig,
} from "./mysql.js";
import {
  compareSchemas,
  ALL_COLUMN_PROPERTIES,
  type CompareResult,
  type Difference,
  type SchemaData,
} from "./compare.js";
import { parseConnectionString, parseArgs, printUsage } from "./args.js";
import { generateMigrationSQL } from "./sql-gen.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function bail(msg: string): never {
  clack.cancel(msg);
  process.exit(1);
}

function handleCancelled(value: unknown): void {
  if (clack.isCancel(value)) bail("Cancelled.");
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const SEV_ICON: Record<Difference["severity"], string> = {
  missing: pc.red("✗ missing"),
  extra: pc.yellow("＋ extra  "),
  diff: pc.blue("~ differs"),
};

const OBJ_COLOR: Record<Difference["object"], (s: string) => string> = {
  table: pc.magenta,
  column: pc.cyan,
  index: pc.green,
  foreignKey: pc.blue,
  trigger: pc.yellow,
};

function renderResults(result: CompareResult): void {
  const { differences, sourceSchema } = result;

  console.log("");
  console.log(pc.bold(pc.bgBlue(pc.white(`  Schema: ${sourceSchema}  `))));
  console.log(pc.dim("─".repeat(72)));

  if (differences.length === 0) {
    console.log(pc.green("  ✔ No differences found."));
    console.log("");
    return;
  }

  // Group by object type
  const groups: Record<Difference["object"], Difference[]> = {
    table: [],
    column: [],
    index: [],
    foreignKey: [],
    trigger: [],
  };
  for (const d of differences) groups[d.object].push(d);

  const order: Difference["object"][] = [
    "table",
    "column",
    "index",
    "foreignKey",
    "trigger",
  ];
  for (const obj of order) {
    const items = groups[obj];
    if (items.length === 0) continue;

    const colorFn = OBJ_COLOR[obj];
    const label =
      obj === "foreignKey" ? "FOREIGN KEYS" : `${obj.toUpperCase()}S`;
    console.log("");
    console.log(pc.bold(colorFn(`  ${label}  (${items.length})`)));
    console.log(pc.dim("  " + "─".repeat(68)));

    for (const d of items) {
      const icon = SEV_ICON[d.severity];
      if (d.properties && d.properties.length > 0) {
        // Grouped property diff: column name as header, each prop on its own line
        console.log(`  ${icon}  ${d.detail}`);
        const maxLen = Math.max(...d.properties.map((p) => p.prop.length));
        for (const p of d.properties) {
          const label = pc.dim(p.prop.padEnd(maxLen));
          const src = pc.yellow(`from:${p.source}`);
          const tgt = pc.red(`to:${p.target}`);
          console.log(`               ${label}  ${tgt}  →  ${src}`);
        }
      } else {
        const lines = d.detail.split("\n");
        console.log(`  ${icon}  ${lines[0]}`);
        for (let i = 1; i < lines.length; i++) {
          console.log(`             ${lines[i]}`);
        }
      }
    }
  }

  console.log("");
  console.log(pc.dim("─".repeat(72)));

  const counts = {
    missing: differences.filter((d) => d.severity === "missing").length,
    extra: differences.filter((d) => d.severity === "extra").length,
    diff: differences.filter((d) => d.severity === "diff").length,
  };

  console.log(
    pc.bold("  Summary: ") +
      pc.red(`${counts.missing} missing`) +
      "  " +
      pc.yellow(`${counts.extra} extra`) +
      "  " +
      pc.blue(`${counts.diff} differs`) +
      "  " +
      pc.dim(`(${differences.length} total)`),
  );
  console.log("");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args) {
    printUsage();
    process.exit(1);
  }

  clack.intro(pc.bgCyan(pc.black(" db-compare ")));

  // Parse URIs
  let srcCfg: ConnectionConfig;
  let tgtCfg: ConnectionConfig;
  try {
    srcCfg = parseConnectionString(args.from);
    tgtCfg = parseConnectionString(args.to);
  } catch (e: unknown) {
    bail(e instanceof Error ? e.message : String(e));
  }

  // Connect
  const connectSpinner = clack.spinner();
  connectSpinner.start("Connecting to both databases…");
  let srcConn: Connection, tgtConn: Connection;
  try {
    [srcConn, tgtConn] = await Promise.all([
      connect(srcCfg!),
      connect(tgtCfg!),
    ]);
  } catch (e: unknown) {
    connectSpinner.stop("Connection failed.");
    bail(e instanceof Error ? e.message : String(e));
  }
  connectSpinner.stop("Connected.");

  // Fetch schema lists for both servers in parallel, then prompt sequentially
  const schemasSpinner = clack.spinner();
  schemasSpinner.start("Fetching available schemas…");
  const [srcSchemas, tgtSchemas] = await Promise.all([
    listDatabases(srcConn),
    listDatabases(tgtConn),
  ]);
  schemasSpinner.stop(
    `Found ${srcSchemas.length} source schemas, ${tgtSchemas.length} target schemas.`,
  );

  if (srcSchemas.length === 0) bail("No databases found on source.");
  if (tgtSchemas.length === 0) bail("No databases found on target.");

  // Auto-pair schemas with the same name; pre-select them all
  const srcSet = new Set(srcSchemas);
  const tgtSet = new Set(tgtSchemas);
  const paired = srcSchemas.filter((s) => tgtSet.has(s)).sort();
  const srcOnly = srcSchemas.filter((s) => !tgtSet.has(s)).sort();
  const tgtOnly = tgtSchemas.filter((s) => !srcSet.has(s)).sort();

  if (srcOnly.length > 0) {
    clack.note(
      srcOnly.map((s) => `  ${pc.red("✗")} ${s}`).join("\n"),
      pc.yellow("Schemas only in source (will not be compared)"),
    );
  }
  if (tgtOnly.length > 0) {
    clack.note(
      tgtOnly.map((s) => `  ${pc.yellow("＋")} ${s}`).join("\n"),
      pc.yellow("Schemas only in target (will not be compared)"),
    );
  }

  if (paired.length === 0)
    bail("No schemas with matching names found between source and target.");

  const selectedPairs = await clack.multiselect<string>({
    message: `Select schema pairs to compare ${pc.dim("(same-named schemas pre-selected)")}`,
    options: paired.map((s) => ({ value: s, label: s })),
    initialValues: paired,
    required: true,
  });
  handleCancelled(selectedPairs);
  const schemaPairs = selectedPairs as unknown as string[];

  // What to compare (asked once, applied to all pairs)
  const compareChoices = await clack.multiselect<string>({
    message: "What to compare?",
    options: [
      { value: "tables", label: "Tables (missing/extra)" },
      { value: "columns", label: "Columns & column properties" },
      { value: "indexes", label: "Indexes" },
      { value: "foreignKeys", label: "Foreign keys" },
      { value: "triggers", label: "Triggers" },
    ],
    initialValues: [
      "tables",
      "columns",
      ...(args.includeIndexes ? ["indexes"] : []),
      ...(args.includeTriggers ? ["triggers"] : []),
    ],
    required: true,
  });
  handleCancelled(compareChoices);
  const choices = compareChoices as unknown as string[];

  const includeIndexes = choices.includes("indexes");
  const includeForeignKeys = choices.includes("foreignKeys");
  const includeTriggers = choices.includes("triggers");

  // If comparing columns, ask which properties to check
  let columnProperties: string[] | undefined;
  let includeMissingColumns = true;
  let includeExtraColumns = true;
  if (choices.includes("columns")) {
    const colPropChoices = await clack.multiselect<string>({
      message: "Which column checks to include?",
      options: [
        {
          value: "_missing",
          label: "missing    — columns in source missing from target",
        },
        {
          value: "_extra",
          label: "extra      — columns in target not in source",
        },
        {
          value: "type",
          label: "type       — column type (e.g. varchar(255), int)",
        },
        { value: "nullable", label: "nullable   — NULL / NOT NULL" },
        { value: "default", label: "default    — DEFAULT value" },
        {
          value: "extra",
          label: "extra attr — e.g. auto_increment, on update",
        },
        { value: "charset", label: "charset    — character set" },
        { value: "collation", label: "collation  — collation" },
        { value: "comment", label: "comment    — column comment" },
      ],
      initialValues: ["_missing", "_extra", ...ALL_COLUMN_PROPERTIES],
      required: true,
    });
    handleCancelled(colPropChoices);
    const allColChoices = colPropChoices as unknown as string[];
    includeMissingColumns = allColChoices.includes("_missing");
    includeExtraColumns = allColChoices.includes("_extra");
    columnProperties = allColChoices.filter((v) => !v.startsWith("_"));
  }

  // If type is being compared, offer to ignore deprecated integer display widths
  let ignoreIntegerWidth = false;
  if (
    choices.includes("columns") &&
    (columnProperties === undefined || columnProperties.includes("type"))
  ) {
    const ignoreWidths = await clack.confirm({
      message:
        "Ignore integer display width differences? (e.g. int(11) vs int — deprecated in MySQL 8)",
      initialValue: true,
    });
    handleCancelled(ignoreWidths);
    ignoreIntegerWidth = ignoreWidths as boolean;
  }

  // Fetch tables for all selected pairs in parallel to determine the table list
  // (used for the optional per-pair table filter, but we ask the filter question once)
  const fetchTablesSpinner = clack.spinner();
  fetchTablesSpinner.start(
    `Fetching table lists for ${schemaPairs.length} schema pair(s)…`,
  );
  const pairTableData = await Promise.all(
    schemaPairs.map(async (schema) => {
      const [src, tgt] = await Promise.all([
        getTables(srcConn, schema),
        getTables(tgtConn, schema),
      ]);
      return { schema, srcTables: src, tgtTables: tgt };
    }),
  );
  fetchTablesSpinner.stop("Table lists fetched.");

  // Build a union of all table names across all pairs for optional filtering
  const allTableNames = [
    ...new Set(
      pairTableData.flatMap(({ srcTables, tgtTables }) => [
        ...srcTables.map((t) => t.name),
        ...tgtTables.map((t) => t.name),
      ]),
    ),
  ].sort();

  // Optional table filter (applied to every pair)
  const filterChoice = await clack.confirm({
    message:
      "Compare all tables? (No = pick specific tables to compare across all pairs)",
    initialValue: true,
  });
  handleCancelled(filterChoice);

  let tableFilter: string[] | undefined;
  if (!filterChoice) {
    const selected = await clack.multiselect<string>({
      message: "Select tables to compare",
      options: allTableNames.map((n) => ({ value: n, label: n })),
      required: true,
    });
    handleCancelled(selected);
    tableFilter = selected as unknown as string[];
  }

  // Fetch full schema data and compare each pair
  interface PairResult {
    result: CompareResult;
    source: SchemaData;
    target: SchemaData;
  }
  const pairResults: PairResult[] = [];
  for (const schema of schemaPairs) {
    const { srcTables, tgtTables } = pairTableData.find(
      (p) => p.schema === schema,
    )!;

    const fetchSpinner = clack.spinner();
    fetchSpinner.start(`Fetching data for schema ${pc.cyan(schema)}…`);

    const [srcColumns, tgtColumns] = await Promise.all([
      getColumns(srcConn, schema),
      getColumns(tgtConn, schema),
    ]);

    const [srcIndexes, tgtIndexes] = includeIndexes
      ? await Promise.all([
          getIndexes(srcConn, schema),
          getIndexes(tgtConn, schema),
        ])
      : [[], []];

    const [srcFKs, tgtFKs] = includeForeignKeys
      ? await Promise.all([
          getForeignKeys(srcConn, schema),
          getForeignKeys(tgtConn, schema),
        ])
      : [[], []];

    const [srcTriggers, tgtTriggers] = includeTriggers
      ? await Promise.all([
          getTriggers(srcConn, schema),
          getTriggers(tgtConn, schema),
        ])
      : [[], []];

    fetchSpinner.stop(`Schema ${pc.cyan(schema)} fetched.`);

    const srcData: SchemaData = {
      schema,
      tables: srcTables,
      columns: srcColumns,
      indexes: srcIndexes,
      foreignKeys: srcFKs,
      triggers: srcTriggers,
    };
    const tgtData: SchemaData = {
      schema,
      tables: tgtTables,
      columns: tgtColumns,
      indexes: tgtIndexes,
      foreignKeys: tgtFKs,
      triggers: tgtTriggers,
    };

    pairResults.push({
      source: srcData,
      target: tgtData,
      result: compareSchemas(srcData, tgtData, {
        includeTables: choices.includes("tables"),
        includeColumns: choices.includes("columns"),
        columnProperties,
        includeMissingColumns,
        includeExtraColumns,
        ignoreIntegerWidth,
        includeIndexes,
        includeForeignKeys,
        includeTriggers,
        tableFilter,
      }),
    });
  }

  // Close connections
  await Promise.all([srcConn.end(), tgtConn.end()]);

  const totalDiffs = pairResults.reduce(
    (n, p) => n + p.result.differences.length,
    0,
  );
  clack.outro(
    pc.bold(
      `Done. Compared ${pairResults.length} schema pair(s). ${totalDiffs} difference(s) found.`,
    ),
  );

  for (const { result } of pairResults) {
    renderResults(result);
  }

  // SQL generation
  const schemasWithDiffs = pairResults.filter(
    (p) => p.result.differences.length > 0,
  );
  if (schemasWithDiffs.length > 0) {
    const wantSQL = await clack.confirm({
      message: "Generate migration SQL?",
      initialValue: false,
    });
    handleCancelled(wantSQL);

    if (wantSQL) {
      const outputChoice = await clack.select({
        message: "Output destination",
        options: [
          { value: "stdout", label: "Print to terminal" },
          { value: "file", label: "Save to .sql files" },
        ],
      });
      handleCancelled(outputChoice);

      for (const { result, source } of schemasWithDiffs) {
        const sql = generateMigrationSQL(result, source);
        if (!sql) continue;

        if (outputChoice === "file") {
          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 19);
          const filename = `migration-${result.sourceSchema}-${timestamp}.sql`;
          const filepath = path.resolve(process.cwd(), filename);
          fs.writeFileSync(filepath, sql, "utf8");
          console.log(pc.green(`  ✔ Saved: ${filepath}`));
        } else {
          console.log(sql);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(pc.red("Fatal error:"), err);
  process.exit(1);
});
