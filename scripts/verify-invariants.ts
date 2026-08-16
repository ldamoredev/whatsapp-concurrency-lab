/**
 * Auditoria de invariantes contra la base. Sale con codigo 1 si algo se rompio.
 *
 *   npm run verify
 *
 * Se corre DESPUES de una corrida de carga o de caos. Es lo que convierte "el escenario
 * termino sin errores" en una afirmacion sobre el sistema: k6 dice lo que el cliente
 * creyo que paso, esto dice lo que quedo escrito.
 *
 * El codigo de salida es la parte importante: asi el escenario de caos puede fallar
 * ruidosamente en vez de imprimir un numero lindo que nadie mira.
 */
import { databaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';
import { auditInvariants } from '../src/infrastructure/persistence/invariants.repository';

async function main(): Promise<void> {
  const pool = createPool(databaseOptions({ applicationName: 'whatsapp-lab-verify' }));

  try {
    const audit = await auditInvariants(pool);

    console.log('Estado final de la base:');
    for (const [name, count] of Object.entries(audit.counts)) {
      console.log(`  ${name.padEnd(26)} ${count}`);
    }

    console.log('\nNo auditables desde el estado final:');
    for (const item of audit.noAuditables) {
      console.log(`  ${item}`);
    }

    if (audit.violations.length > 0) {
      console.error(`\nVIOLACIONES: ${audit.violations.length}`);
      for (const violation of audit.violations) {
        console.error(`  ${violation.invariant}  ${violation.detail}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log('\nI1, I2, I3, I4, I5, I8 e I9 verificadas contra datos: cero violaciones.');
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\nFallo la verificacion: ${error.message}`);
  process.exitCode = 1;
});
