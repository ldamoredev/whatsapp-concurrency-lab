import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { testPool } from './database';

type Queryable = Pool | PoolClient;

export const uuid = (): string => randomUUID();

export async function createConversation(
  db: Queryable = testPool(),
  id: string = uuid(),
): Promise<string> {
  await db.query('INSERT INTO conversations (id) VALUES ($1)', [id]);
  await db.query('INSERT INTO conversation_sequences (conversation_id) VALUES ($1)', [id]);
  return id;
}

export async function createDevice(
  db: Queryable = testPool(),
  ownerId: string = uuid(),
  id: string = uuid(),
): Promise<string> {
  await db.query('INSERT INTO devices (id, owner_id) VALUES ($1, $2)', [id, ownerId]);
  return id;
}

export async function joinConversation(
  conversationId: string,
  deviceId: string,
  db: Queryable = testPool(),
): Promise<void> {
  await db.query('INSERT INTO conversation_devices (conversation_id, device_id) VALUES ($1, $2)', [
    conversationId,
    deviceId,
  ]);
}

export interface ConversationFixture {
  conversationId: string;
  ownerId: string;
  senderDeviceId: string;
  deviceIds: string[];
}

/** Una conversacion con `deviceCount` dispositivos, todos miembros. El primero es el emisor. */
export async function createConversationWithDevices(
  deviceCount = 3,
  db: Queryable = testPool(),
): Promise<ConversationFixture> {
  const conversationId = await createConversation(db);
  const ownerId = uuid();
  const deviceIds: string[] = [];

  for (let index = 0; index < deviceCount; index += 1) {
    const deviceId = await createDevice(db, ownerId);
    await joinConversation(conversationId, deviceId, db);
    deviceIds.push(deviceId);
  }

  return { conversationId, ownerId, senderDeviceId: deviceIds[0], deviceIds };
}

export interface InsertMessageInput {
  id?: string;
  clientMessageId?: string;
  conversationId: string;
  senderId?: string;
  senderDeviceId: string;
  clientSequence: number;
  serverSequence?: number | null;
  status?: 'buffered' | 'published';
  body?: string;
}

export async function insertMessage(
  input: InsertMessageInput,
  db: Queryable = testPool(),
): Promise<string> {
  const id = input.id ?? uuid();
  const serverSequence = input.serverSequence ?? null;
  const status = input.status ?? (serverSequence === null ? 'buffered' : 'published');

  await db.query(
    `INSERT INTO messages (
       id, client_message_id, conversation_id, sender_id, sender_device_id,
       client_sequence, server_sequence, status, body
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.clientMessageId ?? `cm-${id}`,
      input.conversationId,
      input.senderId ?? uuid(),
      input.senderDeviceId,
      input.clientSequence,
      serverSequence,
      status,
      input.body ?? 'hola',
    ],
  );

  return id;
}

export interface InsertIdempotencyInput {
  id?: string;
  actorId?: string;
  route?: string;
  key?: string;
  fingerprint?: string;
  status?: 'in_progress' | 'completed' | 'failed';
  recoveryPoint?: 'started' | 'message_persisted' | 'deliveries_created' | 'completed';
  attempt?: number;
  resourceId?: string | null;
  responseStatus?: number | null;
  responseBody?: unknown;
  leaseUntil?: Date | null;
  expiresAt?: Date;
}

export async function insertIdempotencyOperation(
  input: InsertIdempotencyInput = {},
  db: Queryable = testPool(),
): Promise<string> {
  const id = input.id ?? uuid();

  await db.query(
    `INSERT INTO idempotency_operations (
       id, actor_id, route, key, fingerprint, status, recovery_point,
       attempt, resource_id, response_status, response_body, lease_until, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      input.actorId ?? uuid(),
      input.route ?? 'POST /v1/conversations/:conversationId/messages',
      input.key ?? `key-${id}`,
      input.fingerprint ?? 'fp-abc',
      input.status ?? 'in_progress',
      input.recoveryPoint ?? 'started',
      input.attempt ?? 1,
      input.resourceId ?? null,
      input.responseStatus ?? null,
      input.responseBody === undefined ? null : JSON.stringify(input.responseBody),
      input.leaseUntil ?? null,
      input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    ],
  );

  return id;
}

export interface InsertBatchInput {
  messageId: string;
  expectedCount: number;
  deliveredCount?: number;
  completedAt?: Date | null;
  cleanupAt?: Date | null;
  expiresAt?: Date;
}

export async function insertDeliveryBatch(
  input: InsertBatchInput,
  db: Queryable = testPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO delivery_batches (
       message_id, expected_count, delivered_count, completed_at, cleanup_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.messageId,
      input.expectedCount,
      input.deliveredCount ?? 0,
      input.completedAt ?? null,
      input.cleanupAt ?? null,
      input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    ],
  );
}

export async function insertEnvelope(
  messageId: string,
  deviceId: string,
  state: 'pending' | 'delivered' = 'pending',
  db: Queryable = testPool(),
): Promise<string> {
  const id = uuid();
  await db.query(
    'INSERT INTO delivery_envelopes (id, message_id, device_id, state) VALUES ($1, $2, $3, $4)',
    [id, messageId, deviceId, state],
  );
  return id;
}

export interface InsertReceiptInput {
  messageId: string;
  deviceId: string;
  state?: 'pending' | 'delivered' | 'read';
  deliveredAt?: Date | null;
  readAt?: Date | null;
  version?: number;
}

export async function insertReceipt(
  input: InsertReceiptInput,
  db: Queryable = testPool(),
): Promise<void> {
  const state = input.state ?? 'pending';
  const deliveredAt =
    input.deliveredAt !== undefined
      ? input.deliveredAt
      : state === 'pending'
        ? null
        : new Date();
  const readAt = input.readAt !== undefined ? input.readAt : state === 'read' ? new Date() : null;

  await db.query(
    `INSERT INTO delivery_receipts (message_id, device_id, state, delivered_at, read_at, version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.messageId, input.deviceId, state, deliveredAt, readAt, input.version ?? 0],
  );
}

/** Publica un mensaje y crea su snapshot completo: batch + un envelope y un receipt por dispositivo. */
export async function publishWithDeliveries(
  fixture: ConversationFixture,
  clientSequence: number,
  serverSequence: number,
  db: Queryable = testPool(),
): Promise<string> {
  const messageId = await insertMessage(
    {
      conversationId: fixture.conversationId,
      senderDeviceId: fixture.senderDeviceId,
      clientSequence,
      serverSequence,
      status: 'published',
    },
    db,
  );

  await insertDeliveryBatch({ messageId, expectedCount: fixture.deviceIds.length }, db);

  for (const deviceId of fixture.deviceIds) {
    await insertEnvelope(messageId, deviceId, 'pending', db);
    await insertReceipt({ messageId, deviceId, state: 'pending' }, db);
  }

  return messageId;
}
