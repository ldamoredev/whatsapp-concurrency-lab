import { readiness } from './metrics';

/**
 * Estado de ciclo de vida de la replica.
 *
 * Las tres probes contestan preguntas DISTINTAS, y confundirlas es el error clasico:
 *
 *   startup    ¿termino de arrancar? Protege un boot lento de que liveness lo mate
 *              antes de tiempo.
 *   liveness   ¿el proceso puede progresar? NO consulta la base. Una base caida es
 *              una dependencia compartida: si liveness la chequeara, Kubernetes
 *              reiniciaria las tres replicas a la vez por un problema que ningun
 *              reinicio arregla.
 *   readiness  ¿puedo aceptar trabajo AHORA? Baja al recibir SIGTERM para que el
 *              balanceador deje de mandarme requests antes de que empiece a cerrar.
 */
class Lifecycle {
  private started = false;
  private draining = false;

  markStarted(): void {
    this.started = true;
  }

  /** SIGTERM: dejo de aceptar trabajo nuevo, pero sigo atendiendo lo que ya entro. */
  startDraining(): void {
    this.draining = true;
    readiness.set(0);
  }

  isStarted(): boolean {
    return this.started;
  }

  isDraining(): boolean {
    return this.draining;
  }

  isReady(): boolean {
    return this.started && !this.draining;
  }
}

export const lifecycle = new Lifecycle();
