// src/utils/portUtils.ts
import * as net from 'net';

/**
 * Finds an available port starting from the provided port number
 * @param startPort The port to start checking from
 * @returns A promise that resolves to an available port number
 */
export function findAvailablePort(startPort: number = 7334): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    
    // Handle potential errors
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port is in use, try the next one
        findAvailablePort(startPort + 1)
          .then(resolve)
          .catch(reject);
      } else {
        reject(err);
      }
    });

    // Try to listen on the port
    server.listen(startPort, () => {
      // Found an available port, close the server and return the port
      server.close(() => {
        resolve(startPort);
      });
    });
  });
}
