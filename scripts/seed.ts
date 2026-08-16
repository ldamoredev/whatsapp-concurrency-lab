/**
 * CLI del seed reproducible.
 *
 *   npm run seed                                     5 conversaciones × 3 dispositivos
 *   npm run seed -- --conversations=100 --devices=4
 *   npm run seed -- --json                           salida para consumir desde k6
 *   npm run seed -- --prefix=carga2                  otro conjunto, disjunto del anterior
 *   npm run seed -- --fresh                          ademas, borra el trafico previo
 *
 * `--fresh` NO borra la poblacion: borra los mensajes, entregas y operaciones de
 * idempotencia de esas conversaciones. Es lo que hace repetible una corrida de carga
 * — sin eso, la segunda corrida recibe replays en vez de crear, y mide otra cosa.
 *
 * Correrlo dos veces seguidas no duplica nada: inserta cero filas la segunda vez y lo
 * dice. La logica y el porque estan en src/infrastructure/persistence/seed.repository.ts.
 *
 * En Kubernetes corre como Job con la MISMA imagen que la API, igual que el de
 * migraciones: `npm run k8s:seed`.
 */
import { databaseOptions } from '../src/infrastructure/database/config';
import { createPool } from '../src/infrastructure/database/database';
import {
  resetTraffic,
  seedFixtures,
  type SeedOptions,
} from '../src/infrastructure/persistence/seed.repository';

function readOption(argv: string[], name: string, fallback: string): string {
  const flag = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(flag));
  return found === undefined ? fallback : found.slice(flag.length);
}

function readCount(argv: string[], name: string, fallback: number, max: number): number {
  const raw = readOption(argv, name, String(fallback));
  const value = Number.parseInt(raw, 10);

  // Se valida acá y no en la base: un `--conversations=abc` tiene que fallar antes de
  // abrir una transaccion, con un mensaje que diga que se esperaba.
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`--${name} tiene que ser un entero entre 1 y ${max}; llego "${raw}"`);
  }

  return value;
}

export function optionsFrom(argv: string[]): SeedOptions {
  const devices = readCount(argv, 'devices', 3, 50);

  return {
    conversations: readCount(argv, 'conversations', 5, 10_000),
    devices,
    prefix: readOption(argv, 'prefix', 'lab'),
    // La conversacion caliente de L1: mas dispositivos en la primera conversacion.
    hotDevices: readCount(argv, 'hot-devices', devices, 500),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = optionsFrom(argv);
  const asJson = argv.includes('--json');
  const fresh = argv.includes('--fresh');

  const pool = createPool(databaseOptions({ applicationName: 'whatsapp-lab-seed' }));

  try {
    if (fresh) {
      await resetTraffic(pool, options);
    }

    const result = await seedFixtures(pool, options);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const total = Object.values(result.inserted).reduce((sum, count) => sum + count, 0);

    console.log(
      `Prefijo "${options.prefix}": ${options.conversations} conversacion(es) × ` +
        `${options.devices} dispositivo(s) cada una.`,
    );
    console.log('\nFilas insertadas en esta corrida:');
    for (const [table, count] of Object.entries(result.inserted)) {
      console.log(`  ${table.padEnd(24)} ${count}`);
    }

    if (total === 0) {
      console.log('\nCero filas: el estado pedido ya estaba. Eso es exactamente lo que');
      console.log('tiene que pasar al correr el seed dos veces.');
    }

    const primera = result.conversations[0];
    console.log('\nPrimera conversacion, para probar a mano:');
    console.log(`  conversationId  ${primera.conversationId}`);
    console.log(`  ownerId         ${primera.ownerId}`);
    console.log(`  deviceId[0]     ${primera.deviceIds[0]}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: Error) => {
  console.error(`\nFallo el seed: ${error.message}`);
  process.exitCode = 1;
});
