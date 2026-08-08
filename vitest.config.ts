import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Unit: sin base. Tienen que poder correr sin Docker levantado.
        test: {
          name: 'unit',
          include: ['test/unit/**/*.spec.ts'],
        },
      },
      {
        // Integracion y e2e: PostgreSQL real.
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts', 'test/e2e/**/*.spec.ts'],
          // Comparten una unica base y truncan entre casos. Correrlos en paralelo
          // crearia carreras entre los tests mismos, que es ruido: las carreras que
          // interesan son las que provoca cada test a proposito.
          fileParallelism: false,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
