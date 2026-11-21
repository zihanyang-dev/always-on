import { Cli } from 'kysely-codegen';

await new Cli().run({ argv: process.argv.slice(2) });
