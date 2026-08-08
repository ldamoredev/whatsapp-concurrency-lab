import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    globals: false,
    // Los tests de integracion comparten una unica base real y truncan tablas entre
    // casos. Correrlos en paralelo crearia carreras entre los tests mismos, que es
    // ruido: las carreras que interesan son las que provoca cada test a proposito.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
