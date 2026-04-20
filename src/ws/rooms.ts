import { WebSocket } from 'ws';

interface WsClient {
  socket: WebSocket;
  userId: string;
  username: string;
  role: string;
}

interface WsMessagePayload {
  event: string;
  data: unknown;
}

class WsRoomManager {
  private clients: Map<string, WsClient> = new Map(); // clientId -> WsClient
  private userClients: Map<string, Set<string>> = new Map(); // userId -> Set<clientId>

  addClient(clientId: string, client: WsClient): void {
    this.clients.set(clientId, client);

    if (!this.userClients.has(client.userId)) {
      this.userClients.set(client.userId, new Set());
    }
    this.userClients.get(client.userId)!.add(clientId);

    console.log(`[WS] Client connected: ${client.username} (${clientId}). Total: ${this.clients.size}`);
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.clients.delete(clientId);

    const userSet = this.userClients.get(client.userId);
    if (userSet) {
      userSet.delete(clientId);
      if (userSet.size === 0) {
        this.userClients.delete(client.userId);
      }
    }

    console.log(`[WS] Client disconnected: ${client.username} (${clientId}). Total: ${this.clients.size}`);
  }

  sendToUser(userId: string, message: WsMessagePayload): void {
    const clientIds = this.userClients.get(userId);
    if (!clientIds) return;

    const payload = JSON.stringify(message);
    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  broadcastToAll(message: WsMessagePayload, excludeUserId?: string): void {
    const payload = JSON.stringify(message);
    for (const [, client] of this.clients) {
      if (excludeUserId && client.userId === excludeUserId) continue;
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  broadcastToAdmins(message: WsMessagePayload): void {
    const payload = JSON.stringify(message);
    for (const [, client] of this.clients) {
      if (client.role === 'ADMIN' && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(payload);
      }
    }
  }

  getOnlineUserCount(): number {
    return this.userClients.size;
  }

  getOnlineUsers(): Array<{ userId: string; username: string }> {
    const users: Array<{ userId: string; username: string }> = [];
    for (const [, clientIds] of this.userClients) {
      const firstClientId = clientIds.values().next().value;
      if (firstClientId) {
        const client = this.clients.get(firstClientId);
        if (client) {
          users.push({ userId: client.userId, username: client.username });
        }
      }
    }
    return users;
  }
}

export const wsRooms = new WsRoomManager();
