/**
 * Barrido de trabajo de entrega terminado o vencido.
 *
 *   npm run deliveries:cleanup
 *
 * Es el cuerpo del futuro CronJob de cleanup, ejecutable a mano. Compite con el
 * cleanup inmediato del ultimo ack por la misma puerta: solo uno de los dos limpia.
 */
import { CleanupDeliveriesService } from '../src/application/cleanup-deliveries.service';
import { databaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';

async function main(): Promise<void> {
  const pool = createPool(databaseOptions({ applicationName: 'whatsapp-lab-cleanup' }));

  try {
    const service = new CleanupDeliveriesService(pool);
    const limpiados = await service.run();

    if (limpiados.length === 0) {
      console.log('Sin batches para limpiar.');
    } else {
      console.log(`${limpiados.length} batch(es) limpiados:`);
      for (const batch of limpiados) {
        console.log(
          `  ${batch.messageId}  razon=${batch.reason}  envelopes borrados=${batch.deletedEnvelopes}`,
        );
      }
    }

    // I9: siempre cero. Si no lo fuera, el exit code lo tiene que gritar.
    const violaciones = await service.findViolations();
    if (violaciones.length > 0) {
      console.error(`\nI9 VIOLADA: ${violaciones.length} batch(es) limpiados con pendientes.`);
      for (const v of violaciones) {
        console.error(`  ${v.messageId}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log('\nI9 verificada: ningun batch completado se limpio con dispositivos pendientes.');
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\nFallo el cleanup: ${error.message}`);
  process.exitCode = 1;
});
