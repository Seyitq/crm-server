import { FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { verifyAccessToken } from '../utils/jwt.js';
import { wsRooms } from './rooms.js';
import crypto from 'crypto';

export function wsHandler(socket: WebSocket, request: FastifyRequest): void {
  const clientId = crypto.randomUUID();
  let authenticated = false;
  let pingInterval: ReturnType<typeof setInterval>;

  // Client must send auth message within 5 seconds
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      socket.close(4001, 'Authentication timeout');
    }
  }, 5000);

  socket.on('message', (rawData) => {
    try {
      const message = JSON.parse(rawData.toString());

      if (message.event === 'auth') {
        // Authenticate with JWT
        try {
          const payload = verifyAccessToken(message.data.token);
          authenticated = true;
          clearTimeout(authTimeout);

          wsRooms.addClient(clientId, {
            socket,
            userId: payload.userId,
            username: payload.username,
            role: payload.role,
          });

          socket.send(JSON.stringify({
            event: 'auth:success',
            data: { message: 'Bağlantı başarılı' },
          }));

          // Start heartbeat
          pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.ping();
            }
          }, 15000);

        } catch {
          socket.send(JSON.stringify({
            event: 'auth:error',
            data: { message: 'Geçersiz token' },
          }));
          socket.close(4002, 'Invalid token');
        }
        return;
      }

      if (!authenticated) {
        socket.send(JSON.stringify({
          event: 'error',
          data: { message: 'Önce kimlik doğrulaması yapmalısınız' },
        }));
        return;
      }

      // Handle other message types
      switch (message.event) {
        case 'ping':
          socket.send(JSON.stringify({ event: 'pong', data: { timestamp: Date.now() } }));
          break;

        default:
          // Unknown event type
          break;
      }
    } catch {
      // Invalid JSON — ignore
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimeout);
    if (pingInterval) clearInterval(pingInterval);
    wsRooms.removeClient(clientId);
  });

  socket.on('error', (err) => {
    console.error(`[WS] Socket error for ${clientId}:`, err.message);
  });
}
