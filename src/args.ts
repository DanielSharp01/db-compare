import type { ConnectionConfig } from "./mysql.js";

/**
 * Parse a MySQL connection URI into a ConnectionConfig.
 * Accepted formats:
 *   mysql://user:password@host
 *   mysql://user:password@host:port
 *
 * Schema selection is always done interactively.
 */
export function parseConnectionString(raw: string): ConnectionConfig {
  // Swap the scheme so the built-in URL parser handles it cleanly
  const normalized = raw.replace(/^mysql:\/\//, "http://");

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(
      `Invalid connection string: "${raw}"\n` +
        `Expected format: mysql://user:password@host[:port]`,
    );
  }

  const host = url.hostname;
  if (!host) throw new Error(`Missing host in connection string: "${raw}"`);

  const port = url.port ? parseInt(url.port, 10) : 3306;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  // pathname is "/" or "/dbname"
  const database = url.pathname.replace(/^\//, "") || "";

  return { host, port, user, password, database };
}

export function printUsage(): void {
  console.error(
    [
      "",
      "  db-compare  --from <uri> --to <uri> [options]",
      "",
      "  URIs  mysql://user:password@host[:port]",
      "",
      "  Options",
      "    --indexes    Include index comparison",
      "    --triggers   Include trigger comparison",
      "    --help       Show this help",
      "",
      "  Example",
      "    db-compare \\",
      '      --from "mysql://$DEV_USER:$DEV_PASS@$DEV_HOST" \\',
      '      --to   "mysql://$PROD_USER:$PROD_PASS@$PROD_HOST" \\',
      "      --indexes --triggers",
      "",
    ].join("\n"),
  );
}

export interface CliArgs {
  from: string;
  to: string;
  includeIndexes: boolean;
  includeTriggers: boolean;
}

export function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2); // strip node + script

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const from = get("--from");
  const to = get("--to");

  if (!from || !to) return null;

  return {
    from,
    to,
    includeIndexes: args.includes("--indexes"),
    includeTriggers: args.includes("--triggers"),
  };
}
