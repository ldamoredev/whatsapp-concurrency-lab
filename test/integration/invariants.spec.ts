import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SendMessageService } from '../../src/application/send-message.service';
import { auditInvariants } from '../../src/infrastructure/persistence/invariants.repository';
import { PG_ERROR, closeTestPool, testPool, truncateAll } from './helpers/database';
import { createConversationWithDevices, type ConversationFixture } from './helpers/fixtures';

/**
 * Un verificador que no puede fallar no verifica nada.
 *
 * Estos tests le inyectan violaciones REALES a la base y exigen que las encuentre. Sin
 * esto, `npm run verify` podria estar devolviendo "cero violaciones" porque sus queries
 * no miran nada, y el escenario de caos daria verde para siempre.
 */

let fixture: ConversationFixture;

const service = (): SendMessageService =>
  new SendMessageService(testPool(), { leaseMs: 30_000, ttlMs: 60_000 });

async function publicar(clientSequence: number): Promise<string> {
  const result = await service().send({
    idempotencyKey: `key-${randomUUID()}`,
    conversationId: fixture.conversationId,
    senderId: fixture.ownerId,
    senderDeviceId: fixture.senderDeviceId,
    clientMessageId: `local-${clientSequence}`,
    clientSequence,
    body: `mensaje ${clientSequence}`,
  });
  return result.payload.messageId;
}

beforeEach(async () => {
  await truncateAll();
  fixture = await createConversationWithDevices(3);
});

afterAll(async () => {
  await closeTestPool();
});

describe('auditoria de invariantes', () => {
  it('sobre un sistema sano no encuentra nada', async () => {
    await publicar(1);
    await publicar(2);

    const audit = await auditInvariants(testPool());

    expect(audit.violations).toEqual([]);
    expect(audit.counts.mensajes).toBe(2);
    expect(audit.counts.publicados).toBe(2);
  });

  it('detecta un agujero en server_sequence (I5)', async () => {
    // Es lo que dejaria un contador que se incrementa FUERA de la transaccion que
    // inserta el mensaje: un numero de orden entregado a nadie. Se simula borrando
    // el mensaje del medio.
    await publicar(1);
    const segundo = await publicar(2);
    await publicar(3);

    // Hay que sacar primero el trabajo de entrega: `delivery_batches` referencia al
    // mensaje, y esa FK es justamente lo que impide perder un mensaje por accidente.
    await testPool().query('DELETE FROM delivery_receipts WHERE message_id = $1', [segundo]);
    await testPool().query('DELETE FROM delivery_envelopes WHERE message_id = $1', [segundo]);
    await testPool().query('DELETE FROM delivery_batches WHERE message_id = $1', [segundo]);
    await testPool().query('DELETE FROM messages WHERE id = $1', [segundo]);

    const audit = await auditInvariants(testPool());

    expect(audit.violations.map((v) => v.invariant)).toContain('I5');
    expect(audit.violations.some((v) => v.detail.includes('agujeros'))).toBe(true);
  });

  it('detecta una respuesta persistida que no coincide con el recurso (I3)', async () => {
    await publicar(1);
    await testPool().query(
      `UPDATE idempotency_operations
          SET response_body = jsonb_set(response_body::jsonb, '{messageId}', to_jsonb($1::text))`,
      [randomUUID()],
    );

    const audit = await auditInvariants(testPool());

    expect(audit.violations.map((v) => v.invariant)).toContain('I3');
  });

  it('detecta dos operaciones reclamando el mismo mensaje (I1)', async () => {
    const primero = await publicar(1);
    await publicar(2);
    // Las dos operaciones apuntan ahora al mismo mensaje: un efecto logico con dos
    // dueños es exactamente lo que I1 prohibe.
    await testPool().query('UPDATE idempotency_operations SET resource_id = $1', [primero]);

    const audit = await auditInvariants(testPool());

    expect(audit.violations.map((v) => v.invariant)).toContain('I1');
  });

  it('la violacion de I2 NO se puede inyectar: la constraint la rechaza antes', async () => {
    // Se intento escribir el test al reves —romper I2 y ver si el auditor la
    // encuentra— y resulto imposible: la unicidad de (actor, route, key) no deja
    // existir dos filas con la misma key. Eso NO es una limitacion del test, es la
    // evidencia que I2 pedia: la invariante vive en el schema y no en un `if`.
    //
    // El chequeo de I2 en el auditor queda como red por si alguien dropea la
    // constraint. Se documenta acá para que nadie lo lea como "cubierto por un test"
    // cuando en realidad es inalcanzable mientras la constraint exista.
    await publicar(1);
    await publicar(2);
    const filas = await testPool().query<{ id: string }>(
      'SELECT id FROM idempotency_operations ORDER BY created_at',
    );

    await expect(
      testPool().query(
        `UPDATE idempotency_operations SET key = 'compartida', fingerprint = id::text
          WHERE id = ANY($1::uuid[])`,
        [filas.rows.map((row) => row.id)],
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });

    // Y con la constraint intacta, el auditor no reporta nada.
    const audit = await auditInvariants(testPool());
    expect(audit.violations).toEqual([]);
  });

  it('dice explicitamente que I6, I7 e I10 no se auditan desde el estado final', async () => {
    // Reportar "I1-I10 OK" mirando siete de diez seria dar una garantia que no se tiene.
    const audit = await auditInvariants(testPool());

    expect(audit.noAuditables).toHaveLength(3);
    expect(audit.noAuditables.join(' ')).toMatch(/I6/);
    expect(audit.noAuditables.join(' ')).toMatch(/I7/);
    expect(audit.noAuditables.join(' ')).toMatch(/I10/);
  });
});
