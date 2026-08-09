import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { resolvePublicDir } from './public-path';

/**
 * Sirve el panel.
 *
 * Un mapa FIJO de ruta -> archivo, en vez de un servidor de estaticos generico. Con
 * rutas fijas no existe un path variable que sanitizar, asi que no hay forma de pedir
 * `../../etc/passwd`; y no se agrega una dependencia para un puñado de archivos.
 *
 * Los archivos se leen en cada request a proposito: permite editar el panel y recargar
 * sin reconstruir la imagen, que es el flujo de trabajo del laboratorio.
 */
const PAGES: Record<string, string> = {
  '/': 'index.html',
  '/idempotencia': 'idempotencia.html',
  '/orden': 'orden.html',
  '/entrega': 'entrega.html',
  '/infra': 'infra.html',
};

const ASSETS: Record<string, { file: string; type: string }> = {
  '/panel.css': { file: 'panel.css', type: 'text/css; charset=utf-8' },
  '/lib.js': { file: 'lib.js', type: 'text/javascript; charset=utf-8' },
  '/idempotencia.js': { file: 'idempotencia.js', type: 'text/javascript; charset=utf-8' },
  '/orden.js': { file: 'orden.js', type: 'text/javascript; charset=utf-8' },
  '/entrega.js': { file: 'entrega.js', type: 'text/javascript; charset=utf-8' },
  '/infra.js': { file: 'infra.js', type: 'text/javascript; charset=utf-8' },
};

@Controller()
export class PanelController {
  private readonly publicDir = resolvePublicDir();

  @Get(['/', '/idempotencia', '/orden', '/entrega', '/infra'])
  page(@Res({ passthrough: true }) reply: FastifyReply): string {
    void reply.header('Content-Type', 'text/html; charset=utf-8');
    return this.read(PAGES[reply.request.url.split('?')[0]] ?? 'index.html');
  }

  @Get([
    '/panel.css',
    '/lib.js',
    '/idempotencia.js',
    '/orden.js',
    '/entrega.js',
    '/infra.js',
  ])
  asset(@Res({ passthrough: true }) reply: FastifyReply): string {
    const asset = ASSETS[reply.request.url.split('?')[0]];
    void reply.header('Content-Type', asset.type);
    return this.read(asset.file);
  }

  private read(file: string): string {
    return readFileSync(join(this.publicDir, file), 'utf8');
  }
}
