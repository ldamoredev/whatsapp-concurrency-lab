/**
 * CLI de migraciones.
 *
 *   npm run migrate                 aplica las pendientes contra DATABASE_URL
 *   npm run migrate:status          muestra que hay aplicado y que falta
 *   TEST_DATABASE_URL=... tsx scripts/migrate.ts --test   apunta a la base de tests
 *
 * En Kubernetes esto corre como Job, separado del arranque de cada pod: tres replicas
 * migrando al arrancar es exactamente la carrera que no queremos.
 */
import { join } from 'node:path';
import { databaseOptions, testDatabaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';
import { getAppliedMigrations, loadMigrations, migrate } from '../src/infrastructure/database/migrator';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useTestDatabase = args.includes('--test');
  const statusOnly = args.includes('--status');

  const options = useTestDatabase ? testDatabaseOptions() : databaseOptions();
  const pool = createPool({ ...options, applicationName: 'whatsapp-lab-migrator' });

  // No logueamos la URL completa: lleva credenciales, aunque en el lab sean triviales.
  const target = new URL(options.connectionString);
  console.log(`Base: ${target.pathname.slice(1)} en ${target.host}`);

  try {
    if (statusOnly) {
      const onDisk = loadMigrations(MIGRATIONS_DIR);
      const applied = await getAppliedMigrations(pool);
      const appliedVersions = new Set(applied.map((migration) => migration.version));

      console.log('\nversion  estado      nombre');
      console.log('-------  ----------  ------------------------------------');
      for (const migration of onDisk) {
        const state = appliedVersions.has(migration.version) ? 'aplicada  ' : 'PENDIENTE ';
        console.log(`${migration.version}     ${state}  ${migration.name}`);
      }
      return;
    }

    const result = await migrate(pool, MIGRATIONS_DIR);

    for (const name of result.skipped) {
      console.log(`  = ${name} (ya aplicada)`);
    }
    for (const name of result.applied) {
      console.log(`  + ${name}`);
    }

    console.log(
      result.applied.length === 0
        ? '\nSin migraciones pendientes.'
        : `\n${result.applied.length} migracion(es) aplicada(s).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\nFallo la migracion: ${error.message}`);
  process.exitCode = 1;
});
