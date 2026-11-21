import { globSync, readFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const SERVER_SOURCE = 'apps/server/src/';
const ACCESS_SOURCE = `${SERVER_SOURCE}access/`;
const AUTHENTICATION = `${ACCESS_SOURCE}authentication`;
const DATABASE = `${SERVER_SOURCE}infrastructure/database`;
const MIGRATIONS = 'apps/server/migrations/';
const SOURCE_FILES = '{apps,packages}/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
const MIGRATION_FILES = `${MIGRATIONS}**/*.{ts,mts,cts,js,mjs,cjs}`;
const WORKSPACE_IMPORTS = new Map<string, readonly string[]>([
  ['apps/web', ['@always-on/contracts/http']],
  ['apps/server', ['@always-on/contracts/http', '@always-on/contracts/execution']],
  ['apps/cloud-runner', ['@always-on/contracts/execution']],
  ['apps/device-connector', ['@always-on/contracts/execution']],
]);
const DOMAIN_IMPORTS = new Map<string, readonly string[]>([
  ['work', ['access']],
  ['execution', ['access', 'billing']],
  ['channels', ['access', 'work']],
  ['access', []],
  ['billing', ['access']],
]);
const DATABASE_PACKAGES = new Set([
  '@libsql/client',
  '@prisma/client',
  'better-sqlite3',
  'drizzle-orm',
  'knex',
  'kysely',
  'kysely-codegen',
  'node-pg-migrate',
  'node:sqlite',
  'pg',
  'postgres',
  'prisma',
  'typeorm',
]);
const SERVER_PACKAGE_OWNERS = new Map([
  [
    'standardwebhooks',
    { root: `${SERVER_SOURCE}channels/`, reason: 'Channels own webhook signature verification.' },
  ],
  [
    'better-auth',
    { root: `${AUTHENTICATION}/`, reason: 'The authentication module owns the Better Auth SDK.' },
  ],
]);
const SOURCE_IMPORTS = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportAllDeclaration',
  'TSImportType',
  'ImportExpression',
]);

type ImportEdge = { file: string; workspace: string; specifier: string };
type BoundaryViolation = { specifier: string; reason: string };

/** Checks workspace, server domain, and database imports in one source file. */
export function findBoundaryViolations(file: string, code: string): BoundaryViolation[] {
  const workspace = file.split('/').slice(0, 2).join('/');
  const violations: BoundaryViolation[] = [];
  visit(parseAst(code, { lang: sourceLanguage(file) }, file));
  return violations;

  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value) || typeof value.type !== 'string') return;

    const specifier = moduleSpecifier(value);
    if (specifier !== undefined) {
      const reason = checkImport({ file, workspace, specifier });
      if (reason) violations.push({ specifier, reason });
    }

    for (const child of Object.values(value)) visit(child);
  }
}

function sourceLanguage(file: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (/\.[cm]?ts$/.test(file)) return 'ts';
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.jsx')) return 'jsx';
  return 'js';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function moduleSpecifier(node: Record<string, unknown>): string | undefined {
  const source = moduleSource(node);
  if (isRecord(source) && source.type === 'Literal' && typeof source.value === 'string')
    return source.value;
}

function moduleSource(node: Record<string, unknown>): unknown {
  if (typeof node.type === 'string' && SOURCE_IMPORTS.has(node.type)) return node.source;
  if (node.type !== 'CallExpression' || !isRecord(node.callee)) return;
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
  if (Array.isArray(node.arguments)) return node.arguments[0];
}

function checkImport({ file, workspace, specifier }: ImportEdge): string | undefined {
  if (/^\.{1,2}\//.test(specifier)) return checkRelativeImport({ file, workspace, specifier });
  if (posix.isAbsolute(specifier) || specifier.startsWith('file:'))
    return 'Use a relative import within the workspace project or a public package export.';

  if (specifier.startsWith('@always-on/')) {
    if (!WORKSPACE_IMPORTS.get(workspace)?.includes(specifier))
      return 'Use one of the public contracts allowed for this application.';
    return;
  }

  const packageName = specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

  if (DATABASE_PACKAGES.has(packageName) && !isPersistence(file))
    return 'Database drivers and ORM imports belong in server persistence or migrations.';
  if (workspace !== 'apps/server') return;

  const owner = SERVER_PACKAGE_OWNERS.get(packageName);
  if (owner && !file.startsWith(owner.root)) return owner.reason;
}

function checkRelativeImport({ file, workspace, specifier }: ImportEdge): string | undefined {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (!target.startsWith(`${workspace}/`)) return 'Use a public package export to cross projects.';
  if (workspace !== 'apps/server') return;

  if (target === DATABASE || target.startsWith(`${DATABASE}/`))
    return checkDatabaseImport(file, target);

  if (!target.startsWith(SERVER_SOURCE)) {
    if (file.startsWith(MIGRATIONS) && target.startsWith(MIGRATIONS)) return;
    return 'Server source imports stay in src; migrations are a separate entry point.';
  }

  if (isSchemaFile(target) && DOMAIN_IMPORTS.has(serverArea(target) ?? '') && !isPersistence(file))
    return 'Keep database schema imports in persistence; call the owning store instead.';
  if (file.startsWith(MIGRATIONS) && isPersistence(target) && isSchemaFile(target)) return;

  return checkServerAreaImport(file, target);
}

function checkDatabaseImport(file: string, target: string): string | undefined {
  const isDatabaseEntry = isPublicEntry(target, DATABASE);
  if (serverArea(file) === 'entrypoints' && isDatabaseEntry) return;
  if (!isPersistence(file)) return 'Call a store operation to access the database.';
  if (!file.startsWith(`${DATABASE}/`) && !isDatabaseEntry)
    return 'Use the public database infrastructure index.';
}

function checkServerAreaImport(file: string, target: string): string | undefined {
  const from = serverArea(file);
  const to = serverArea(target);
  if (from === to) return from === 'access' ? checkAccessImport(file, target) : undefined;
  if (!from || !to || to === 'entrypoints') return 'Only a process entry point owns startup code.';
  if (!isPublicEntry(target, `${SERVER_SOURCE}${to}`)) return 'Use the target area’s public index.';
  if (from === 'entrypoints') return;
  if (from === 'http' && to === 'infrastructure') return;
  if (DOMAIN_IMPORTS.has(from) && (to === 'http' || to === 'infrastructure')) return;
  if (!DOMAIN_IMPORTS.get(from)?.includes(to)) return `${from} cannot import ${to}.`;
}

function checkAccessImport(file: string, target: string): string | undefined {
  const from = accessFeature(file);
  const to = accessFeature(target);
  if (from === to) {
    if (
      from &&
      target.includes('/persistence/') &&
      !isPersistence(file) &&
      !isPublicEntry(file, from)
    )
      return 'Call an owning store operation instead of importing persistence internals.';
    return;
  }

  if (!to) return 'Access features cannot import their composition entry.';
  if (!isPublicEntry(target, to)) return 'Use the Access feature’s public index.';
  if (from === AUTHENTICATION)
    return 'Authentication cannot depend on Workspace access or other Access features.';
}

function accessFeature(file: string): string | undefined {
  const featureName = file.slice(ACCESS_SOURCE.length).split('/')[0];
  if (featureName && file.startsWith(`${ACCESS_SOURCE}${featureName}/`))
    return `${ACCESS_SOURCE}${featureName}`;
}

function serverArea(file: string): string | undefined {
  if (file.startsWith(SERVER_SOURCE)) return file.slice(SERVER_SOURCE.length).split('/')[0];
}

function isPublicEntry(file: string, area: string): boolean {
  return file.startsWith(`${area}/`) && /^index\.[cm]?[jt]s$/.test(file.slice(area.length + 1));
}

function isSchemaFile(file: string): boolean {
  return /(?:\/|-)schema\.[cm]?[jt]s$/.test(file);
}

function isPersistence(file: string): boolean {
  if (file.startsWith(`${DATABASE}/`) || file.startsWith(MIGRATIONS)) return true;
  if (!DOMAIN_IMPORTS.has(serverArea(file) ?? '')) return false;
  return file.includes('/persistence/') || /-store(?:\.test)?\.[cm]?[jt]s$/.test(file);
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = globSync([SOURCE_FILES, MIGRATION_FILES], { cwd: root })
    .map((file) => file.split(sep).join('/'))
    .sort();
  const violations = files.flatMap((file) =>
    findBoundaryViolations(file, readFileSync(join(root, file), 'utf8')).map(
      ({ specifier, reason }) => `${file} → ${specifier}  ${reason}`,
    ),
  );

  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Checked ${files.length} files against workspace and server boundaries.`);
  }
}
