import { globSync, readFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCES = '{apps,packages}/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
const WORKSPACE_DEPENDENCIES = {
  'apps/cli': ['contracts', 'agent-runtime'],
  'apps/server': ['contracts', 'agent-runtime'],
  'apps/web': ['contracts'],
  'packages/agent-runtime': ['contracts'],
  'packages/contracts': [],
};
const SERVER_SDK_OWNERS = {
  '@better-auth/drizzle-adapter': /^apps\/server\/src\/infrastructure\/authentication\//,
  '@earendil-works/pi-ai': /^packages\/agent-runtime\/src\/pi\//,
  '@earendil-works/pi-coding-agent':
    /^(?:packages\/agent-runtime\/src\/pi\/|apps\/server\/src\/bootstrap\/cloud-agent\.ts$)/,
  'better-auth': /^apps\/server\/src\/(?:infrastructure\/authentication|workspaces)\//,
  bullmq: /^apps\/server\/src\/tasks\/worker\.ts$/,
  e2b: /^apps\/server\/src\/sandbox\//,
  ioredis: /^apps\/server\/src\/(?:infrastructure\/(?:redis|authentication)|sessions)\//,
  pg: /^apps\/server\/src\/infrastructure\/database\//,
};
const SERVER_ROOT = 'apps/server/src/';
const RELATIVE_PATH = /^\.{1,2}\//;

/** Checks static module edges, including type references and re-exports. */
export function findBoundaryViolations(file, source) {
  const workspace = file.split('/').slice(0, 2).join('/');
  const violations = [];
  const syntax = parseAst(source, { lang: getLanguage(file) }, file);
  visit(syntax);

  return violations;

  function visit(node) {
    const specifier = getModuleSource(node);
    if (typeof specifier?.value === 'string') {
      const reason = checkImport({ file, workspace, specifier: specifier.value });
      if (reason) violations.push({ source: specifier.value, reason });
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (isSyntaxNode(item)) visit(item);
      } else if (isSyntaxNode(child)) {
        visit(child);
      }
    }
  }
}

function checkImport({ file, workspace, specifier }) {
  if (RELATIVE_PATH.test(specifier)) return checkRelativeImport({ file, workspace, specifier });
  if (specifier.startsWith('/') || specifier.startsWith('file:'))
    return 'Use a workspace package export or a relative import within this package.';

  const packageName = specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');
  if (packageName.startsWith('@always-on/')) {
    const allowed = WORKSPACE_DEPENDENCIES[workspace] ?? [];
    return allowed.includes(packageName.slice('@always-on/'.length))
      ? undefined
      : 'Workspace dependency is outside the allowed package direction.';
  }
  if (workspace === 'packages/contracts' && !file.endsWith('.test.ts') && packageName !== 'zod')
    return 'Public contracts may only depend on Zod.';

  const owner = Object.hasOwn(SERVER_SDK_OWNERS, packageName)
    ? SERVER_SDK_OWNERS[packageName]
    : undefined;
  if (owner && !owner.test(file)) return 'Import this SDK only from its owning module.';
}

function checkRelativeImport({ file, workspace, specifier }) {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (!target.startsWith(`${workspace}/src/`))
    return 'Use a package export to cross workspace boundaries.';

  if (workspace !== 'apps/server') return;
  const from = getServerFeature(file);
  const to = getServerFeature(target);
  if (to === from) return;
  if (to === 'bootstrap') return 'Only the process entry layer can depend on bootstrap code.';
  if (from === 'api' || (from.startsWith('infrastructure/') && !to.startsWith('infrastructure/')))
    return 'Shared infrastructure and HTTP middleware cannot depend on product features.';
  if (target !== `${SERVER_ROOT}${to}/index.js`) return 'Use the target feature’s public index.js.';
}

function getServerFeature(file) {
  const [area, module] = file.slice(SERVER_ROOT.length).split('/');
  return area === 'infrastructure' ? `${area}/${module}` : area;
}

function getLanguage(file) {
  if (/\.[cm]?ts$/.test(file)) return 'ts';
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.jsx')) return 'jsx';
  return 'js';
}

function getModuleSource(node) {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'TSImportType':
    case 'ImportExpression':
      return node.source;
    default:
      return undefined;
  }
}

function isSyntaxNode(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string';
}

if (import.meta.main) {
  const files = globSync(SOURCES, { cwd: ROOT })
    .map((file) => file.split(sep).join('/'))
    .sort();
  const violations = files.flatMap((file) =>
    findBoundaryViolations(file, readFileSync(join(ROOT, file), 'utf8')).map(
      ({ source, reason }) => `${file} → ${source}  ${reason}`,
    ),
  );

  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Checked ${files.length} source files against import boundaries.`);
  }
}
