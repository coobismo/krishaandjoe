import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

function memoriesDirectoryRedirect(request, response, next) {
  const url = new URL(request.url, 'http://localhost');
  if (['GET', 'HEAD'].includes(request.method) && url.pathname === '/memories') {
    response.writeHead(308, { Location: `/memories/${url.search}` });
    response.end();
  } else next();
}

export default defineConfig({
  appType: 'mpa',
  plugins: [{
    name: 'memories-directory',
    configureServer(server) { server.middlewares.use(memoriesDirectoryRedirect); },
    configurePreviewServer(server) { server.middlewares.use(memoriesDirectoryRedirect); },
  }],
  build: {
    rolldownOptions: {
      input: {
        home: fileURLToPath(new URL('./index.html', import.meta.url)),
        memories: fileURLToPath(new URL('./memories/index.html', import.meta.url)),
      },
    },
  },
});
