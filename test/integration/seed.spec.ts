import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import {
  deterministicUuid,
  planFor,
  seedFixtures,
} from '../../src/infrastructure/persistence/seed.repository';
import { closeTestPool, countRows, testPool, truncateAll } from './helpers/database';

const opciones = { conversations: 4, devices: 3, prefix: 'test-seed' };

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

describe('seed reproducible', () => {
  it('crea la poblacion pedida: N conversaciones con M dispositivos cada una', async () => {
    const result = await seedFixtures(testPool(), opciones);

    expect(await countRows('conversations')).toBe(4);
    expect(await countRows('conversation_sequences')).toBe(4);
    expect(await countRows('devices')).toBe(12);
    expect(await countRows('conversation_devices')).toBe(12);

    expect(result.conversations).toHaveLength(4);
    for (const conversation of result.conversations) {
      expect(conversation.deviceIds).toHaveLength(3);
    }
  });

  it('correrlo dos veces NO duplica nada, y la segunda corrida inserta cero filas', async () => {
    // Es la propiedad que hace repetible una corrida de carga. Si esto se rompe, dos
    // mediciones que se comparan entre si arrancan desde poblaciones distintas y la
    // diferencia deja de ser atribuible a lo que se estaba probando.
    const primera = await seedFixtures(testPool(), opciones);
    const segunda = await seedFixtures(testPool(), opciones);

    expect(Object.values(primera.inserted).every((count) => count > 0)).toBe(true);
    expect(segunda.inserted).toEqual({
      conversations: 0,
      conversation_sequences: 0,
      devices: 0,
      conversation_devices: 0,
    });

    expect(await countRows('conversations')).toBe(4);
    expect(await countRows('devices')).toBe(12);
    expect(await countRows('conversation_devices')).toBe(12);

    // Y los ids son los mismos, no solo la cantidad.
    expect(segunda.conversations).toEqual(primera.conversations);
  });

  it('los ids NO dependen del reloj ni del azar: mismo prefijo, mismos uuid', async () => {
    // Esto es lo que permite que la maquina A y la maquina B hablen de la misma
    // conversacion sin pasarse ids por otro canal.
    expect(planFor(opciones)).toEqual(planFor(opciones));
    expect(deterministicUuid('lab', 'conversation', '0')).toBe(
      deterministicUuid('lab', 'conversation', '0'),
    );
  });

  it('dos prefijos distintos dan poblaciones disjuntas', async () => {
    const uno = await seedFixtures(testPool(), { ...opciones, prefix: 'carga-a' });
    const otro = await seedFixtures(testPool(), { ...opciones, prefix: 'carga-b' });

    const idsUno = new Set(uno.conversations.map((c) => c.conversationId));
    const compartidos = otro.conversations.filter((c) => idsUno.has(c.conversationId));

    expect(compartidos).toEqual([]);
    expect(await countRows('conversations')).toBe(8);
  });

  it('genera uuid validos, que es lo unico que la base va a aceptar', async () => {
    const uuid = deterministicUuid('lab', 'conversation', '0');

    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // Y la prueba real: que Postgres lo acepte como uuid, no que matchee un regex.
    const round = await testPool().query<{ value: string }>('SELECT $1::uuid AS value', [uuid]);
    expect(round.rows[0].value).toBe(uuid);
  });
});
