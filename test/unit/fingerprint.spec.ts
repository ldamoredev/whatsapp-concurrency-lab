import { describe, expect, it } from 'vitest';
import { canonicalize, fingerprintOf, type MessageEffect } from '../../src/domain/idempotency/fingerprint';

const base: MessageEffect = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  senderId: '22222222-2222-4222-8222-222222222222',
  senderDeviceId: '33333333-3333-4333-8333-333333333333',
  clientMessageId: 'local-1',
  clientSequence: 1,
  body: 'hola',
};

describe('canonicalize', () => {
  it('ordena las claves, asi que el orden del JSON no cambia el resultado', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
  });

  it('ordena en profundidad', () => {
    expect(canonicalize({ x: { b: 2, a: 1 } })).toBe(canonicalize({ x: { a: 1, b: 2 } }));
  });

  it('NO ordena arrays: ahi el orden es parte del valor', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('distingue tipos: el numero 1 no es el string "1"', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }));
  });

  it('distingue null de ausente', () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });
});

describe('fingerprintOf', () => {
  it('es estable: el mismo pedido da siempre el mismo hash', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base }));
  });

  it('no depende del orden con el que se armo el objeto', () => {
    const reordered: MessageEffect = {
      body: base.body,
      clientSequence: base.clientSequence,
      clientMessageId: base.clientMessageId,
      senderDeviceId: base.senderDeviceId,
      senderId: base.senderId,
      conversationId: base.conversationId,
    };

    expect(fingerprintOf(reordered)).toBe(fingerprintOf(base));
  });

  it('cambia si cambia cualquier campo del efecto', () => {
    const original = fingerprintOf(base);

    expect(fingerprintOf({ ...base, body: 'chau' })).not.toBe(original);
    expect(fingerprintOf({ ...base, clientSequence: 2 })).not.toBe(original);
    expect(fingerprintOf({ ...base, clientMessageId: 'local-2' })).not.toBe(original);
    expect(fingerprintOf({ ...base, conversationId: base.senderId })).not.toBe(original);
    expect(fingerprintOf({ ...base, senderDeviceId: base.senderId })).not.toBe(original);
    expect(fingerprintOf({ ...base, senderId: base.senderDeviceId })).not.toBe(original);
  });

  it('NO colisiona cuando el contenido se corre de un campo al otro', () => {
    // Este es el bug clasico de concatenar valores: con `a + b`, {a:'x', b:'yz'} y
    // {a:'xy', b:'z'} dan la misma cadena. Dos pedidos distintos con el mismo
    // fingerprint = un mensaje que se pierde en silencio porque parece un replay.
    const uno = fingerprintOf({ ...base, clientMessageId: 'ab', body: 'c' });
    const otro = fingerprintOf({ ...base, clientMessageId: 'a', body: 'bc' });

    expect(uno).not.toBe(otro);
  });

  it('un body con comillas o llaves no puede imitar la estructura del hash', () => {
    const inyeccion = fingerprintOf({ ...base, body: '","clientSequence":999,"x":"' });
    const normal = fingerprintOf({ ...base, body: 'hola' });

    expect(inyeccion).not.toBe(normal);
    expect(inyeccion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('devuelve un sha256 en hex', () => {
    expect(fingerprintOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
