import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from "@nestjs/websockets";
import { Logger, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "../../modules/auth/auth.service";
import { Namespace, Server, Socket } from "socket.io";
import IORedis from "ioredis";
import { createAdapter } from "@socket.io/redis-adapter";

type ClientAuthData = {
  token?: string;
  tenantId?: string;
};

type SocketContext = {
  userId: string;
  tenantId: string;
  role: string;
  sessionId: string;
};

@WebSocketGateway({
  namespace: "/ws/operations",
  cors: {
    origin: "*"
  }
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly redisUrl = process.env.SOCKET_IO_REDIS_URL ?? process.env.REDIS_URL;
  private pubClient: IORedis | null = null;
  private subClient: IORedis | null = null;

  @WebSocketServer()
  private server!: Namespace;

  constructor(private readonly authService: AuthService) {}

  afterInit(server: Namespace): void {
    if (!this.redisUrl) {
      this.logger.log("Socket.IO Redis adapter disabled: no redis URL configured");
      return;
    }

    this.pubClient = new IORedis(this.redisUrl, {
      maxRetriesPerRequest: null
    });
    this.subClient = this.pubClient.duplicate();

    server.server.adapter(createAdapter(this.pubClient, this.subClient));
    this.logger.log(`Socket.IO Redis adapter enabled (${this.redisUrl})`);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const auth = (client.handshake.auth ?? {}) as ClientAuthData;
      const token = this.extractToken(auth.token ?? this.getAuthorizationHeader(client));
      if (!token) {
        throw new UnauthorizedException("Missing websocket token");
      }

      const payload = await this.authService.verifyAccessToken(token);
      const tenantId = auth.tenantId ?? this.getTenantHeader(client);
      if (!tenantId || tenantId !== payload.tenantId) {
        throw new UnauthorizedException("Tenant mismatch in websocket connection");
      }

      const context: SocketContext = {
        userId: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
        sessionId: payload.sessionId
      };

      client.data.context = context;
      await client.join(this.tenantRoom(payload.tenantId));
      await client.join(this.userRoom(payload.tenantId, payload.sub));

      this.logger.log(
        `WebSocket connected socket=${client.id} tenant=${payload.tenantId} user=${payload.sub}`
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unauthorized";
      this.logger.warn(`WebSocket auth failed socket=${client.id} reason=${reason}`);
      client.emit("error", { message: "Unauthorized websocket connection" });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`WebSocket disconnected socket=${client.id}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pubClient) {
      await this.pubClient.quit();
    }
    if (this.subClient) {
      await this.subClient.quit();
    }
  }

  @SubscribeMessage("ping")
  ping(@ConnectedSocket() client: Socket): { ok: boolean; timestamp: string } {
    const context = client.data.context as SocketContext | undefined;
    if (!context) {
      throw new UnauthorizedException("Unauthorized socket context");
    }

    return {
      ok: true,
      timestamp: new Date().toISOString()
    };
  }

  @SubscribeMessage("subscribe.reservation")
  subscribeReservation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { reservationId?: string }
  ): { success: boolean } {
    const context = client.data.context as SocketContext | undefined;
    if (!context) {
      throw new UnauthorizedException("Unauthorized socket context");
    }

    if (!body?.reservationId) {
      return { success: false };
    }

    client.join(this.reservationRoom(context.tenantId, body.reservationId));
    return { success: true };
  }

  emitReservationCreated(payload: {
    tenantId: string;
    reservationId: string;
    pickupTime: string;
  }): void {
    this.server.to(this.tenantRoom(payload.tenantId)).emit("reservation.created", payload);
  }

  emitReservationStatusUpdated(payload: {
    tenantId: string;
    reservationId: string;
    previousStatus: string;
    nextStatus: string;
    reason?: string;
  }): void {
    this.server
      .to(this.tenantRoom(payload.tenantId))
      .emit("reservation.status.updated", payload);

    this.server
      .to(this.reservationRoom(payload.tenantId, payload.reservationId))
      .emit("reservation.status.updated", payload);
  }

  private extractToken(tokenOrBearer?: string): string | null {
    if (!tokenOrBearer) {
      return null;
    }

    if (tokenOrBearer.startsWith("Bearer ")) {
      return tokenOrBearer.slice("Bearer ".length).trim();
    }

    return tokenOrBearer.trim();
  }

  private getAuthorizationHeader(client: Socket): string | undefined {
    const header = client.handshake.headers.authorization;
    if (typeof header === "string") {
      return header;
    }
    return undefined;
  }

  private getTenantHeader(client: Socket): string | undefined {
    const header = client.handshake.headers["x-tenant-id"];
    if (typeof header === "string") {
      return header;
    }
    return undefined;
  }

  private tenantRoom(tenantId: string): string {
    return `tenant.${tenantId}`;
  }

  private userRoom(tenantId: string, userId: string): string {
    return `tenant.${tenantId}.user.${userId}`;
  }

  private reservationRoom(tenantId: string, reservationId: string): string {
    return `tenant.${tenantId}.reservation.${reservationId}`;
  }
}
