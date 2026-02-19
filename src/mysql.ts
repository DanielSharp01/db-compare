import mysql2 from "mysql2/promise";

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export type Connection = mysql2.Connection;

export async function connect(cfg: ConnectionConfig): Promise<Connection> {
  return mysql2.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: false,
  });
}

// ── Schema list ───────────────────────────────────────────────────────────────

export async function listDatabases(conn: Connection): Promise<string[]> {
  const [rows] = await conn.query<mysql2.RowDataPacket[]>(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
  );
  return rows.map((r) => r.SCHEMA_NAME as string);
}

// ── Tables ────────────────────────────────────────────────────────────────────

export interface TableDef {
  name: string;
  engine: string;
  tableCollation: string;
  tableComment: string;
}

export async function getTables(
  conn: Connection,
  schema: string,
): Promise<TableDef[]> {
  const [rows] = await conn.query<mysql2.RowDataPacket[]>(
    `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_COMMENT
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [schema],
  );
  return rows.map((r) => ({
    name: r.TABLE_NAME as string,
    engine: r.ENGINE as string,
    tableCollation: r.TABLE_COLLATION as string,
    tableComment: r.TABLE_COMMENT as string,
  }));
}

// ── Columns ───────────────────────────────────────────────────────────────────

export interface ColumnDef {
  table: string;
  name: string;
  ordinalPosition: number;
  columnDefault: string | null;
  isNullable: string; // 'YES' | 'NO'
  dataType: string;
  columnType: string; // full type e.g. varchar(255)
  characterMaximumLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  characterSetName: string | null;
  collationName: string | null;
  extra: string; // e.g. 'auto_increment'
  columnComment: string;
  columnKey: string; // PRI, UNI, MUL
}

export async function getColumns(
  conn: Connection,
  schema: string,
): Promise<ColumnDef[]> {
  const [rows] = await conn.query<mysql2.RowDataPacket[]>(
    `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION,
            COLUMN_DEFAULT, IS_NULLABLE, DATA_TYPE, COLUMN_TYPE,
            CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
            CHARACTER_SET_NAME, COLLATION_NAME, EXTRA, COLUMN_COMMENT, COLUMN_KEY
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  );
  return rows.map((r) => ({
    table: r.TABLE_NAME as string,
    name: r.COLUMN_NAME as string,
    ordinalPosition: r.ORDINAL_POSITION as number,
    columnDefault: r.COLUMN_DEFAULT as string | null,
    isNullable: r.IS_NULLABLE as string,
    dataType: r.DATA_TYPE as string,
    columnType: r.COLUMN_TYPE as string,
    characterMaximumLength: r.CHARACTER_MAXIMUM_LENGTH as number | null,
    numericPrecision: r.NUMERIC_PRECISION as number | null,
    numericScale: r.NUMERIC_SCALE as number | null,
    characterSetName: r.CHARACTER_SET_NAME as string | null,
    collationName: r.COLLATION_NAME as string | null,
    extra: r.EXTRA as string,
    columnComment: r.COLUMN_COMMENT as string,
    columnKey: r.COLUMN_KEY as string,
  }));
}

// ── Indexes ───────────────────────────────────────────────────────────────────

export interface IndexDef {
  table: string;
  indexName: string;
  nonUnique: number;
  seqInIndex: number;
  columnName: string;
  indexType: string;
  comment: string;
}

export async function getIndexes(
  conn: Connection,
  schema: string,
): Promise<IndexDef[]> {
  const [rows] = await conn.query<mysql2.RowDataPacket[]>(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX,
            COLUMN_NAME, INDEX_TYPE, COMMENT
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  );
  return rows.map((r) => ({
    table: r.TABLE_NAME as string,
    indexName: r.INDEX_NAME as string,
    nonUnique: r.NON_UNIQUE as number,
    seqInIndex: r.SEQ_IN_INDEX as number,
    columnName: r.COLUMN_NAME as string,
    indexType: r.INDEX_TYPE as string,
    comment: r.COMMENT as string,
  }));
}

// ── Triggers ──────────────────────────────────────────────────────────────────

export interface TriggerDef {
  name: string;
  table: string;
  event: string; // INSERT | UPDATE | DELETE
  timing: string; // BEFORE | AFTER
  statement: string;
  definer: string;
}

// ── Foreign Keys ────────────────────────────────────────────────────────────

export interface ForeignKeyDef {
  name: string;
  table: string;
  columns: string; // comma-joined, ordered by ORDINAL_POSITION
  refTable: string;
  refColumns: string; // comma-joined
  onUpdate: string;
  onDelete: string;
}

export async function getForeignKeys(
  conn: Connection,
  schema: string,
): Promise<ForeignKeyDef[]> {
  const [rows] = await conn.query<mysql2.RowDataPacket[]>(
    `SELECT
       kcu.CONSTRAINT_NAME,
       kcu.TABLE_NAME,
       GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ',') AS COLUMNS,
       kcu.REFERENCED_TABLE_NAME,
       GROUP_CONCAT(kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ',') AS REF_COLUMNS,
       rc.UPDATE_RULE,
       rc.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE kcu
     JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
       ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
      AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
      AND rc.TABLE_NAME        = kcu.TABLE_NAME
     WHERE kcu.TABLE_SCHEMA = ?
       AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
     GROUP BY kcu.CONSTRAINT_NAME, kcu.TABLE_NAME, kcu.REFERENCED_TABLE_NAME, rc.UPDATE_RULE, rc.DELETE_RULE
     ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME`,
    [schema],
  );
  return rows.map((r) => ({
    name: r.CONSTRAINT_NAME as string,
    table: r.TABLE_NAME as string,
    columns: r.COLUMNS as string,
    refTable: r.REFERENCED_TABLE_NAME as string,
    refColumns: r.REF_COLUMNS as string,
    onUpdate: r.UPDATE_RULE as string,
    onDelete: r.DELETE_RULE as string,
  }));
}

export async function getTriggers(
  conn: Connection,
  schema: string,
): Promise<TriggerDef[]> {
  const [rows] = await conn.query<mysql2.RowDataPacket[]>(
    `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION,
            ACTION_TIMING, ACTION_STATEMENT, DEFINER
     FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = ?
     ORDER BY TRIGGER_NAME`,
    [schema],
  );
  return rows.map((r) => ({
    name: r.TRIGGER_NAME as string,
    table: r.EVENT_OBJECT_TABLE as string,
    event: r.EVENT_MANIPULATION as string,
    timing: r.ACTION_TIMING as string,
    statement: r.ACTION_STATEMENT as string,
    definer: r.DEFINER as string,
  }));
}
