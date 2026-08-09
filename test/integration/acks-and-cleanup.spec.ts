import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AckService } from '../../src/application/ack.service';
import { CleanupDeliveriesService } from '../../src/application/cleanup-deliveries.service';
import { SendMessageService } from '../../src/application/send-message.service';
import { DeviceNotInSnapshotError, MessageNotFoundError } from '../../src/domain/idempotency/errors';
import { findReceipt } from '../../src/infrastructure/persistence/acks.repository';
import { closeTestPool, countRows, testPool, truncateAll } from './helpers/database';
import {
  createConversationWithDevices,
  createDevice,
  joinConversation,
  type ConversationFixture,
} from './helpers/fixtures';

let fixture: ConversationFixture;
let messageId: string;

const acks = (options = {}): AckService => new AckService(testPool(), options);
const cleanup = (): CleanupDeliveriesService => new CleanupDeliveriesService(testPool());

/** Publica un mensaje y devuelve su id, con snapshot para los 3 dispositivos. */
async function publicar(): Promise<string> {
  const service = new SendMessageService(testPool(), { leaseMs: 30_000, ttlMs: 60_000 });
  const result = await service.send({
    idempotencyKey: `key-${randomUUID()}`,
    conversationId: fixture.conversationId,
    senderId: fixture.ownerId,
    senderDeviceId: fixture.senderDeviceId,
    clientMessageId: 'local-1',
    clientSequence: 1,
    body: 'hola',
  });
  return result.payload.messageId;
}

async function batch() {
  const result = await testPool().query<{
    expected_count: number;
    delivered_count: number;
    completed_at: Date | null;
    cleanup_at: Date | null;
    cleanup_reason: string | null;
  }>(
    `SELECT expected_count, delivered_count, completed_at, cleanup_at, cleanup_reason
       FROM delivery_batches WHERE message_id = $1`,
    [messageId],
  );
  return result.rows[0];
}

const envelopesRestantes = async (): Promise<number> => {
  const result = await testPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM delivery_envelopes WHERE message_id = $1',
    [messageId],
  );
  return Number.parseInt(result.rows[0].count, 10);
};

beforeEach(async () => {
  await truncateAll();
  fixture = await createConversationWithDevices(3);
  messageId = await publicar();
});

afterAll(async () => {
  await closeTestPool();
});

describe('I7 — el recibo nunca retrocede', () => {
  it('avanza pending → delivered → read', async () => {
    const svc = acks();
    const device = fixture.deviceIds[0];

    const entregado = await svc.ack({ messageId, deviceId: device, state: 'delivered' });
    expect(entregado.state).toBe('delivered');
    expect(entregado.advanced).toBe(true);

    const leido = await svc.ack({ messageId, deviceId: device, state: 'read' });
    expect(leido.state).toBe('read');
    expect(leido.advanced).toBe(true);

    const receipt = await findReceipt(testPool(), messageId, device);
    expect(receipt?.state).toBe('read');
    expect(receipt?.deliveredAt).not.toBeNull();
    expect(receipt?.readAt).not.toBeNull();
    expect(receipt?.version).toBe(2);
  });

  it('un ack ATRASADO no hace retroceder el estado', async () => {
    const svc = acks();
    const device = fixture.deviceIds[0];

    await svc.ack({ messageId, deviceId: device, state: 'read' });

    // Llega tarde el `delivered` que se habia perdido en la red.
    const atrasado = await svc.ack({ messageId, deviceId: device, state: 'delivered' });

    expect(atrasado.advanced).toBe(false);
    expect(atrasado.state).toBe('read');

    const receipt = await findReceipt(testPool(), messageId, device);
    expect(receipt?.state).toBe('read');
    // Y no gasto una version: no hubo escritura.
    expect(receipt?.version).toBe(1);
  });

  it('pending → read directo es valido y deja los dos timestamps coherentes', async () => {
    const svc = acks();
    await svc.ack({ messageId, deviceId: fixture.deviceIds[0], state: 'read' });

    const receipt = await findReceipt(testPool(), messageId, fixture.deviceIds[0]);
    expect(receipt?.state).toBe('read');
    // El CHECK del schema no admite un `read` sin `delivered_at`: se completa solo.
    expect(receipt?.deliveredAt).not.toBeNull();
    expect(receipt?.readAt).not.toBeNull();
  });

  it('el primer delivered_at gana: un ack posterior no reescribe cuando ocurrio', async () => {
    const svc = acks();
    const device = fixture.deviceIds[0];

    await svc.ack({ messageId, deviceId: device, state: 'delivered' });
    const primero = await findReceipt(testPool(), messageId, device);

    await svc.ack({ messageId, deviceId: device, state: 'read' });
    const despues = await findReceipt(testPool(), messageId, device);

    expect(despues?.deliveredAt?.getTime()).toBe(primero?.deliveredAt?.getTime());
  });
});

describe('I8 — un ack duplicado no cuenta dos veces', () => {
  it('20 acks identicos del mismo dispositivo suman UNO al progreso', async () => {
    const svc = acks();
    const device = fixture.deviceIds[0];

    for (let i = 0; i < 20; i += 1) {
      await svc.ack({ messageId, deviceId: device, state: 'delivered' });
    }

    const b = await batch();
    expect(b.delivered_count).toBe(1);
    expect(b.expected_count).toBe(3);
    expect(b.completed_at).toBeNull();
  });

  it('CARRERA: 30 acks CONCURRENTES del mismo dispositivo suman UNO', async () => {
    const svc = acks();
    const device = fixture.deviceIds[0];

    const resultados = await Promise.allSettled(
      Array.from({ length: 30 }, () => svc.ack({ messageId, deviceId: device, state: 'delivered' })),
    );

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(30);

    // Exactamente uno de los 30 movio el recibo. Los otros 29 fueron no-op.
    const avanzaron = resultados.filter(
      (r) => r.status === 'fulfilled' && r.value.advanced,
    );
    expect(avanzaron).toHaveLength(1);

    const b = await batch();
    expect(b.delivered_count).toBe(1);

    const receipt = await findReceipt(testPool(), messageId, device);
    expect(receipt?.version).toBe(1);
  });

  it('pasar de delivered a read NO vuelve a sumar: el umbral se cruza una sola vez', async () => {
    const svc = acks();
    const device = fixture.deviceIds[0];

    await svc.ack({ messageId, deviceId: device, state: 'delivered' });
    expect((await batch()).delivered_count).toBe(1);

    await svc.ack({ messageId, deviceId: device, state: 'read' });
    expect((await batch()).delivered_count).toBe(1);
  });
});

describe('el snapshot es inmutable', () => {
  it('un dispositivo FUERA del snapshot no cambia el batch', async () => {
    // Se agrega despues de publicar: el snapshot ya estaba congelado.
    const tardio = await createDevice();
    await joinConversation(fixture.conversationId, tardio);

    await expect(
      acks().ack({ messageId, deviceId: tardio, state: 'delivered' }),
    ).rejects.toBeInstanceOf(DeviceNotInSnapshotError);

    const b = await batch();
    expect(b.expected_count).toBe(3);
    expect(b.delivered_count).toBe(0);
    // Y no se creo un recibo para el: el snapshot no crece.
    expect(await countRows('delivery_receipts')).toBe(3);
  });

  it('expected_count no cambia si despues se agrega un dispositivo', async () => {
    const nuevo = await createDevice();
    await joinConversation(fixture.conversationId, nuevo);

    expect((await batch()).expected_count).toBe(3);
  });

  it('un mensaje inexistente da MESSAGE_NOT_FOUND, no DEVICE_NOT_IN_SNAPSHOT', async () => {
    await expect(
      acks().ack({ messageId: randomUUID(), deviceId: fixture.deviceIds[0], state: 'delivered' }),
    ).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});

/**
 * C4 del alcance:
 *  1. dos dispositivos mandan acks duplicados y fuera de orden
 *  2. verificar que todavia existen envelopes pendientes
 *  3. el tercero ackea concurrentemente varias veces
 *  4. verificar receipts monotonicos, conteo correcto y un unico cleanup
 *  5. repetir mientras corre tambien el CronJob de cleanup
 */
describe('C4 — ack multi-dispositivo', () => {
  it('recorre el escenario completo: acks desordenados, cleanup unico', async () => {
    const svc = acks();
    const [a, b, c] = fixture.deviceIds;

    // 1. Dos dispositivos, acks duplicados y fuera de orden.
    await svc.ack({ messageId, deviceId: a, state: 'read' });
    await svc.ack({ messageId, deviceId: a, state: 'delivered' }); // atrasado
    await svc.ack({ messageId, deviceId: a, state: 'read' }); // duplicado
    await svc.ack({ messageId, deviceId: b, state: 'delivered' });
    await svc.ack({ messageId, deviceId: b, state: 'delivered' }); // duplicado

    // 2. Falta el tercero: I9 exige que el trabajo siga ahi.
    let estado = await batch();
    expect(estado.delivered_count).toBe(2);
    expect(estado.completed_at).toBeNull();
    expect(estado.cleanup_at).toBeNull();
    expect(await envelopesRestantes()).toBe(3);

    // 3. El tercero ackea concurrentemente varias veces.
    const resultados = await Promise.all(
      Array.from({ length: 10 }, () => svc.ack({ messageId, deviceId: c, state: 'delivered' })),
    );

    // 4. Receipts monotonicos, conteo correcto y UN solo cleanup.
    expect(resultados.filter((r) => r.advanced)).toHaveLength(1);
    expect(resultados.filter((r) => r.batch.cleanedUp)).toHaveLength(1);

    estado = await batch();
    expect(estado.delivered_count).toBe(3);
    expect(estado.completed_at).not.toBeNull();
    expect(estado.cleanup_at).not.toBeNull();
    expect(estado.cleanup_reason).toBe('completed');

    // Los envelopes se liberaron...
    expect(await envelopesRestantes()).toBe(0);

    // ...y la evidencia sobrevive.
    expect(await countRows('delivery_receipts')).toBe(3);
    expect(await countRows('delivery_batches')).toBe(1);

    const estados = await testPool().query<{ state: string }>(
      'SELECT state FROM delivery_receipts WHERE message_id = $1 ORDER BY device_id',
      [messageId],
    );
    expect(estados.rows.every((row) => ['delivered', 'read'].includes(row.state))).toBe(true);

    // I9 verificada contra la base, despues del cleanup.
    expect(await cleanup().findViolations()).toEqual([]);
  });

  it('el CronJob corriendo DURANTE los acks no produce un segundo cleanup', async () => {
    const svc = acks();
    const cron = cleanup();

    // Los tres dispositivos ackean mientras el barrido corre en paralelo, varias veces.
    const trabajo = [
      ...fixture.deviceIds.flatMap((deviceId) =>
        Array.from({ length: 5 }, () => svc.ack({ messageId, deviceId, state: 'delivered' })),
      ),
      ...Array.from({ length: 8 }, () => cron.run()),
    ];

    await Promise.all(trabajo);

    const estado = await batch();
    expect(estado.delivered_count).toBe(3);
    expect(estado.cleanup_at).not.toBeNull();
    expect(await envelopesRestantes()).toBe(0);

    // I10 — una sola limpieza. El batch sigue existiendo, con su razon registrada.
    expect(await countRows('delivery_batches')).toBe(1);
    expect(estado.cleanup_reason).toBe('completed');
    expect(await countRows('delivery_receipts')).toBe(3);
    expect(await cleanup().findViolations()).toEqual([]);
  });

  it('I9 — el barrido NO limpia un batch con dispositivos pendientes', async () => {
    await acks().ack({ messageId, deviceId: fixture.deviceIds[0], state: 'delivered' });

    const limpiados = await cleanup().run();

    expect(limpiados).toHaveLength(0);
    expect(await envelopesRestantes()).toBe(3);
    expect((await batch()).cleanup_at).toBeNull();
  });
});

describe('I10 — el cleanup ocurre una sola vez', () => {
  it('CARRERA: 10 barridos concurrentes limpian UNO solo', async () => {
    const svc = acks({ cleanupOnComplete: false });
    for (const deviceId of fixture.deviceIds) {
      await svc.ack({ messageId, deviceId, state: 'delivered' });
    }
    expect((await batch()).completed_at).not.toBeNull();
    expect(await envelopesRestantes()).toBe(3);

    const cron = cleanup();
    const corridas = await Promise.all(Array.from({ length: 10 }, () => cron.run()));

    // Exactamente un barrido se llevo el batch. Los otros nueve no encontraron nada.
    expect(corridas.flat()).toHaveLength(1);
    expect(corridas.flat()[0].deletedEnvelopes).toBe(3);
    expect(await envelopesRestantes()).toBe(0);
  });

  it('volver a barrer despues no cambia nada', async () => {
    const svc = acks({ cleanupOnComplete: false });
    for (const deviceId of fixture.deviceIds) {
      await svc.ack({ messageId, deviceId, state: 'delivered' });
    }

    expect(await cleanup().run()).toHaveLength(1);
    expect(await cleanup().run()).toHaveLength(0);
    expect(await cleanup().run()).toHaveLength(0);
  });
});

describe('TTL — el dispositivo que nunca vuelve', () => {
  it('un batch vencido se limpia por TTL, con la razon registrada', async () => {
    // Vencido hace un rato, y con dos de tres dispositivos pendientes para siempre.
    await acks().ack({ messageId, deviceId: fixture.deviceIds[0], state: 'delivered' });
    await testPool().query(
      "UPDATE delivery_batches SET expires_at = now() - interval '1 hour' WHERE message_id = $1",
      [messageId],
    );

    const limpiados = await cleanup().run();

    expect(limpiados).toHaveLength(1);
    expect(limpiados[0].reason).toBe('expired');
    expect(await envelopesRestantes()).toBe(0);

    const estado = await batch();
    // Nunca se completo, y el registro lo dice: no se disfraza de entrega exitosa.
    expect(estado.completed_at).toBeNull();
    expect(estado.cleanup_reason).toBe('expired');

    // Los receipts sobreviven y muestran quien nunca recibio el mensaje.
    const pendientes = await testPool().query<{ count: string }>(
      "SELECT count(*)::text AS count FROM delivery_receipts WHERE message_id = $1 AND state = 'pending'",
      [messageId],
    );
    expect(pendientes.rows[0].count).toBe('2');

    // Y no cuenta como violacion de I9: la razon es `expired`, no `completed`.
    expect(await cleanup().findViolations()).toEqual([]);
  });

  it('un ack posterior al cleanup por TTL sigue funcionando sobre el recibo durable', async () => {
    await testPool().query(
      "UPDATE delivery_batches SET expires_at = now() - interval '1 hour' WHERE message_id = $1",
      [messageId],
    );
    await cleanup().run();
    expect(await envelopesRestantes()).toBe(0);

    // El dispositivo vuelve a la vida y ackea. El envelope ya no existe, pero el
    // recibo si: la evidencia sigue siendo actualizable.
    const resultado = await acks().ack({
      messageId,
      deviceId: fixture.deviceIds[0],
      state: 'delivered',
    });

    expect(resultado.advanced).toBe(true);
    expect(resultado.state).toBe('delivered');
    expect((await batch()).delivered_count).toBe(1);
  });
});

describe('estado terminal configurable', () => {
  it("con terminal='read', un `delivered` NO completa el batch", async () => {
    const svc = acks({ terminalState: 'read' });

    for (const deviceId of fixture.deviceIds) {
      await svc.ack({ messageId, deviceId, state: 'delivered' });
    }

    // Ninguno cruzo el umbral: el trabajo sigue pendiente.
    expect((await batch()).delivered_count).toBe(0);
    expect(await envelopesRestantes()).toBe(3);

    for (const deviceId of fixture.deviceIds) {
      await svc.ack({ messageId, deviceId, state: 'read' });
    }

    expect((await batch()).delivered_count).toBe(3);
    expect(await envelopesRestantes()).toBe(0);
  });
});
