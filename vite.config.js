// vite.config.js
export default {
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3010', // Backend
        changeOrigin: true,
        secure: false,
      },
      '/auth': {
        target: 'http://localhost:3010',
        changeOrigin: true,
        secure: false,
      },
    },
  },
};
