import { defineConfig } from 'vite';

    export default defineConfig({
      server: {
        host: process.env.HOST || 'localhost',
        port: parseInt(process.env.PORT, 10) || 3000
      }
    });
