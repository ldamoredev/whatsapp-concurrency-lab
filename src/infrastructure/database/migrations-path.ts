import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Ubicacion del directorio de migraciones.
 *
 * No se puede resolver con un `join(__dirname, '..', 'migrations')` fijo porque el
 * mismo codigo corre desde dos layouts distintos:
 *
 *   tsx        scripts/migrate.ts       -> ../migrations  ✅
 *   compilado  dist/scripts/migrate.js  -> ../migrations  ❌ (apunta a dist/migrations)
 *
 * Ese desajuste no aparece en desarrollo: aparece dentro del contenedor, que es el
 * peor lugar para descubrirlo. Se resuelve buscando hacia arriba hasta encontrar el
 * directorio de verdad, y `MIGRATIONS_DIR` permite fijarlo a mano si hiciera falta.
 */
export function resolveMigrationsDir(fromDir: string = __dirname): string {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`MIGRATIONS_DIR apunta a "${fromEnv}", que no existe.`);
    }
    return resolve(fromEnv);
  }

  let current = fromDir;

  // Se sube hasta la raiz del filesystem como mucho; en la practica corta al segundo
  // o tercer nivel.
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'migrations');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    `No se encontro el directorio "migrations" partiendo de ${fromDir}. ` +
      'Fijalo con MIGRATIONS_DIR.',
  );
}
