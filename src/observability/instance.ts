import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Identidad de esta replica.
 *
 * En Kubernetes el hostname del pod ES el nombre del pod, asi que sirve tal cual y no
 * hace falta inyectar nada. `INSTANCE_ID` permite fijarlo a mano en Docker Compose,
 * donde el hostname es un hash poco legible.
 *
 * Existe SOLO para el laboratorio: es la evidencia de que el load balancer repartio
 * las carreras entre replicas. Un sistema real no le cuenta al cliente que pod lo
 * atendio.
 */
export const INSTANCE_ID: string =
  process.env.INSTANCE_ID ?? hostname() ?? `instance-${randomBytes(3).toString('hex')}`;
