import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { resolvePublicDir } from './public-path';

/**
 * Sirve el panel.
 *
 * Tres rutas FIJAS en vez de un servidor de estaticos generico: con rutas fijas no hay
 * forma de pedir `../../etc/passwd`, no hace falta sanitizar nada y no se agrega una
 * dependencia para tres archivos.
 *
 * Los archivos se leen en cada request a proposito: permite editar el panel y recargar
 * sin reconstruir la imagen, que es el flujo de trabajo del laboratorio.
 */
@Controller()
export class PanelController {
  private readonly publicDir = resolvePublicDir();

  @Get('/')
  index(@Res({ passthrough: true }) reply: FastifyReply): string {
    void reply.header('Content-Type', 'text/html; charset=utf-8');
    return this.read('index.html');
  }

  @Get('/panel.css')
  styles(@Res({ passthrough: true }) reply: FastifyReply): string {
    void reply.header('Content-Type', 'text/css; charset=utf-8');
    return this.read('panel.css');
  }

  @Get('/panel.js')
  script(@Res({ passthrough: true }) reply: FastifyReply): string {
    void reply.header('Content-Type', 'text/javascript; charset=utf-8');
    return this.read('panel.js');
  }

  private read(file: string): string {
    return readFileSync(join(this.publicDir, file), 'utf8');
  }
}
