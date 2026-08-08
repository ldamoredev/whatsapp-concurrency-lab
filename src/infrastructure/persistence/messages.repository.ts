import { randomUUID } from 'node:crypto';
import { DatabaseError, type Pool, type PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const STREAM_SEQUENCE_CONSTRAINT = 'messages_stream_client_sequence_uniq';
export const SENDER_MEMBERSHIP_CONSTRAINT = 'messages_sender_membership_fkey';

export interface StoredMessage {
  id: string;
  clientMessageId: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  clientSequence: number;
  serverSequence: number | null;
  status: 'buffered' | 'published';
  body: string;
  createdAt: Date;
}

interface MessageRow {
  id: string;
  client_message_id: string;
  conversation_id: string;
  sender_id: string;
  sender_device_id: string;
  client_sequence: string;
  server_sequence: string | null;
  status: 'buffered' | 'published';
  body: string;
  created_at: Date;
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    clientMessageId: row.client_message_id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderDeviceId: row.sender_device_id,
    // bigint llega como string desde Postgres; se parsea explicitamente.
    clientSequence: Number.parseInt(row.client_sequence, 10),
    serverSequence: row.server_sequence === null ? null : Number.parseInt(row.server_sequence, 10),
    status: row.status,
    body: row.body,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `
  id, client_message_id, conversation_id, sender_id, sender_device_id,
  client_sequence, server_sequence, status, body, created_at
`;

export async function findMessageById(
  db: Queryable,
  messageId: string,
): Promise<StoredMessage | null> {
  const result = await db.query<MessageRow>(
    `SELECT ${SELECT_COLUMNS} FROM messages WHERE id = $1`,
    [messageId],
  );
  return result.rows.length > 0 ? toMessage(result.rows[0]) : null;
}

export async function findMessageByStreamPosition(
  db: Queryable,
  conversationId: string,
  senderDeviceId: string,
  clientSequence: number,
): Promise<StoredMessage | null> {
  const result = await db.query<MessageRow>(
    `SELECT ${SELECT_COLUMNS} FROM messages
      WHERE conversation_id = $1 AND sender_device_id = $2 AND client_sequence = $3`,
    [conversationId, senderDeviceId, clientSequence],
  );
  return result.rows.length > 0 ? toMessage(result.rows[0]) : null;
}

/**
 * Toma el contador de orden visible de la conversacion CON LOCK.
 *
 * `FOR UPDATE` sobre la unica fila de `conversation_sequences` de esa conversacion es
 * el punto de serializacion del orden: dos transacciones que publican a la vez en la
 * misma conversacion se ordenan aca, no en la aplicacion. La segunda espera a que la
 * primera commitee y recien entonces lee el contador ya incrementado.
 *
 * El lock es por conversacion, no global: dos conversaciones distintas publican en
 * paralelo sin tocarse.
 *
 * Devuelve `null` si la conversacion no existe.
 */
export async function lockNextServerSequence(
  client: PoolClient,
  conversationId: string,
): Promise<number | null> {
  const result = await client.query<{ next_server_sequence: string }>(
    `SELECT next_server_sequence
       FROM conversation_sequences
      WHERE conversation_id = $1
        FOR UPDATE`,
    [conversationId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  return Number.parseInt(result.rows[0].next_server_sequence, 10);
}

/** Avanza el contador. Se llama en la misma transaccion que tomo el lock. */
export async function advanceServerSequence(
  client: PoolClient,
  conversationId: string,
): Promise<void> {
  await client.query(
    `UPDATE conversation_sequences
        SET next_server_sequence = next_server_sequence + 1,
            version = version + 1
      WHERE conversation_id = $1`,
    [conversationId],
  );
}

export interface InsertMessageInput {
  clientMessageId: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: string;
  clientSequence: number;
  serverSequence: number;
  body: string;
}

export type InsertMessageResult =
  | { outcome: 'inserted'; message: StoredMessage }
  | { outcome: 'stream_position_taken' }
  | { outcome: 'sender_not_member' };

/**
 * Inserta el mensaje ya publicado.
 *
 * El INSERT va dentro de un SAVEPOINT: si choca contra I4 (la posicion del stream ya
 * esta tomada), la transaccion queda abortada en Postgres y no se podria seguir
 * consultando nada. El savepoint permite volver un paso atras, averiguar quien ocupa
 * esa posicion y decidir si es un replay o un conflicto, todo sin perder el lock del
 * contador que ya se tomo.
 */
export async function insertPublishedMessage(
  client: PoolClient,
  input: InsertMessageInput,
): Promise<InsertMessageResult> {
  const id = randomUUID();

  await client.query('SAVEPOINT insert_message');

  try {
    const result = await client.query<MessageRow>(
      `INSERT INTO messages (
         id, client_message_id, conversation_id, sender_id, sender_device_id,
         client_sequence, server_sequence, status, body
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'published', $8)
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        input.clientMessageId,
        input.conversationId,
        input.senderId,
        input.senderDeviceId,
        input.clientSequence,
        input.serverSequence,
        input.body,
      ],
    );

    await client.query('RELEASE SAVEPOINT insert_message');
    return { outcome: 'inserted', message: toMessage(result.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT insert_message');

    if (error instanceof DatabaseError) {
      if (error.code === UNIQUE_VIOLATION && error.constraint === STREAM_SEQUENCE_CONSTRAINT) {
        return { outcome: 'stream_position_taken' };
      }
      if (
        error.code === FOREIGN_KEY_VIOLATION &&
        error.constraint === SENDER_MEMBERSHIP_CONSTRAINT
      ) {
        return { outcome: 'sender_not_member' };
      }
    }

    throw error;
  }
}
