/**
 * Barrido de huecos vencidos.
 *
 *   npm run gaps:expire
 *
 * Es el cuerpo del futuro CronJob de expiracion, ejecutable a mano. El alcance pide
 * explicitamente que el cleanup se pueda correr manualmente para los tests.
 */
import { databaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';
import { expireOverdueGaps } from '../src/infrastructure/persistence/device-sequences.repository';

async function main(): Promise<void> {
  const pool = createPool(databaseOptions({ applicationName: 'whatsapp-lab-gap-expirer' }));

  try {
    const expired = await expireOverdueGaps(pool);

    if (expired.length === 0) {
      console.log('Sin huecos vencidos.');
      return;
    }

    console.log(`${expired.length} stream(s) pasaron a resync_required:`);
    for (const stream of expired) {
      console.log(
        `  conversacion ${stream.conversationId}  dispositivo ${stream.deviceId}  ` +
          `esperaba client_sequence ${stream.nextClientSequence}`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\nFallo el barrido: ${error.message}`);
  process.exitCode = 1;
});
