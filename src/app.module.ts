import { Module } from '@nestjs/common';
import { DatabaseModule } from './infrastructure/database/database.module';

/**
 * Slice 1: solo scaffold y acceso a datos.
 *
 * Todavia no hay controllers. Los endpoints de envio idempotente y de acks llegan en
 * los slices 2 y 4; agregarlos ahora seria escribir logica sin las constraints
 * verificadas debajo.
 */
@Module({
  imports: [DatabaseModule],
})
export class AppModule {}
