import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Ubicacion de los archivos del panel.
 *
 * Mismo problema que las migraciones: `__dirname` es `src/http` con tsx y
 * `dist/src/http` compilado, asi que una ruta relativa fija apunta a lugares distintos.
 * Ese bug solo aparece dentro del contenedor. Se busca hacia arriba.
 */
export function resolvePublicDir(fromDir: string = __dirname): string {
  const fromEnv = process.env.PUBLIC_DIR;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`PUBLIC_DIR apunta a "${fromEnv}", que no existe.`);
    }
    return resolve(fromEnv);
  }

  let current = fromDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'public');
    if (existsSync(join(candidate, 'index.html'))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`No se encontro el directorio "public" partiendo de ${fromDir}.`);
}
