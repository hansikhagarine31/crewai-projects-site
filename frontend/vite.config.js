import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: ['..'] }, // the sample inputs are read from shared/samples
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  test: {
    globals: true,
    include: ['test/**/*.test.js', 'src/**/*.test.{js,jsx}'],
    setupFiles: ['./test/setup.js'],
  },
});
