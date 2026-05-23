import { compare, hash } from "bcryptjs";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { sign, verify } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { getCurrentTenantId } from "../../common/context/request-context";
import { PrismaService } from "../../common/prisma/prisma.service";

type LoginInput = {
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
};

type RefreshInput = {
  refreshToken: string;
  ipAddress?: string;
  userAgent?: string;
};

type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
};

type RefreshPayload = {
  type: "refresh";
  sub: string;
  tenantId: string;
  sessionId: string;
  role: UserRole;
};

export type AccessPayload = {
  type: "access";
  sub: string;
  tenantId: string;
  sessionId: string;
  role: UserRole;
};

@Injectable()
export class AuthService {
  private readonly accessTtlSeconds = 60 * 15;
  private readonly refreshTtlSeconds = 60 * 60 * 24 * 7;
  private readonly suspiciousLockMinutes = 15;

  constructor(private readonly prisma: PrismaService) {}

  async login(input: LoginInput): Promise<TokenPair> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const user = await this.prisma.user.findFirst({
      where: {
        tenantId,
        email: input.email,
        isActive: true,
        deletedAt: null
      }
    });

    if (!user?.passwordHash) {
      throw new UnauthorizedException("Invalid credentials");
    }

    this.assertUserNotLocked(user.authLockedUntil, user.authLockReason);

    const validPassword = await compare(input.password, user.passwordHash);
    if (!validPassword) {
      throw new UnauthorizedException("Invalid credentials");
    }

    return this.issueSessionTokens({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    });
  }

  async refresh(input: RefreshInput): Promise<TokenPair> {
    const payload = this.verifyRefreshToken(input.refreshToken);

    const session = await this.prisma.authSession.findFirst({
      where: {
        id: payload.sessionId,
        tenantId: payload.tenantId,
        userId: payload.sub
      }
    });

    if (!session) {
      throw new UnauthorizedException("Session is invalid or expired");
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        tenantId: payload.tenantId,
        isActive: true,
        deletedAt: null
      }
    });

    if (!user) {
      throw new UnauthorizedException("User not found or inactive");
    }

    this.assertUserNotLocked(user.authLockedUntil, user.authLockReason);

    if (session.compromisedAt) {
      throw new UnauthorizedException("Session is locked due to suspicious activity");
    }

    if (session.revokedAt) {
      await this.lockUserSessionsForSuspiciousRefresh({
        tenantId: payload.tenantId,
        userId: payload.sub,
        sessionId: session.id,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent
      });
      throw new UnauthorizedException("Refresh token reuse detected. Session locked.");
    }

    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Session is invalid or expired");
    }

    const refreshMatches = await compare(input.refreshToken, session.refreshTokenHash);
    if (!refreshMatches) {
      await this.lockUserSessionsForSuspiciousRefresh({
        tenantId: payload.tenantId,
        userId: payload.sub,
        sessionId: session.id,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent
      });
      throw new UnauthorizedException("Suspicious refresh activity detected. Session locked.");
    }

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() }
    });

    return this.issueSessionTokens({
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    });
  }

  async logout(authorization?: string): Promise<{ success: boolean }> {
    const token = this.extractBearerToken(authorization);
    if (!token) {
      return { success: true };
    }

    try {
      const payload = verify(token, this.getAccessSecret()) as {
        sessionId?: string;
      };

      if (payload.sessionId) {
        await this.prisma.authSession.updateMany({
          where: {
            id: payload.sessionId,
            revokedAt: null
          },
          data: {
            revokedAt: new Date()
          }
        });
      }
    } catch {
      return { success: true };
    }

    return { success: true };
  }

  async verifyAccessToken(token: string): Promise<AccessPayload> {
    let payload: unknown;
    try {
      payload = verify(token, this.getAccessSecret());
    } catch {
      throw new UnauthorizedException("Invalid access token");
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as { type?: string }).type !== "access"
    ) {
      throw new UnauthorizedException("Invalid access token");
    }

    const typedPayload = payload as Partial<AccessPayload>;
    if (!typedPayload.sub || !typedPayload.tenantId || !typedPayload.sessionId || !typedPayload.role) {
      throw new UnauthorizedException("Invalid access token");
    }

    const session = await this.prisma.authSession.findFirst({
      where: {
        id: typedPayload.sessionId,
        userId: typedPayload.sub,
        tenantId: typedPayload.tenantId,
        revokedAt: null,
        expiresAt: {
          gt: new Date()
        }
      }
    });

    if (!session) {
      throw new UnauthorizedException("Session is invalid or revoked");
    }

    if (session.compromisedAt) {
      throw new UnauthorizedException("Session is locked due to suspicious activity");
    }

    return typedPayload as AccessPayload;
  }

  private async issueSessionTokens(input: {
    userId: string;
    tenantId: string;
    role: UserRole;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<TokenPair> {
    const sessionId = randomUUID();

    const accessToken = sign(
      {
        type: "access",
        sub: input.userId,
        tenantId: input.tenantId,
        role: input.role,
        sessionId
      },
      this.getAccessSecret(),
      { expiresIn: this.accessTtlSeconds }
    );

    const refreshToken = sign(
      {
        type: "refresh",
        sub: input.userId,
        tenantId: input.tenantId,
        role: input.role,
        sessionId
      },
      this.getRefreshSecret(),
      { expiresIn: this.refreshTtlSeconds }
    );

    const refreshTokenHash = await hash(refreshToken, 10);
    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        tenantId: input.tenantId,
        userId: input.userId,
        refreshTokenHash,
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
        expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000)
      }
    });

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: this.accessTtlSeconds
    };
  }

  private verifyRefreshToken(token: string): RefreshPayload {
    let payload: unknown;
    try {
      payload = verify(token, this.getRefreshSecret());
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      (payload as { type?: string }).type !== "refresh"
    ) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const typedPayload = payload as Partial<RefreshPayload>;
    if (!typedPayload.sub || !typedPayload.tenantId || !typedPayload.sessionId || !typedPayload.role) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    return typedPayload as RefreshPayload;
  }

  private async lockUserSessionsForSuspiciousRefresh(input: {
    tenantId: string;
    userId: string;
    sessionId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + this.suspiciousLockMinutes * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      await tx.authSession.updateMany({
        where: {
          id: input.sessionId,
          tenantId: input.tenantId,
          userId: input.userId,
          compromisedAt: null
        },
        data: {
          compromisedAt: now,
          compromisedReason: "refresh_token_reuse_detected",
          revokedAt: now
        }
      });

      await tx.authSession.updateMany({
        where: {
          tenantId: input.tenantId,
          userId: input.userId,
          revokedAt: null
        },
        data: {
          revokedAt: now
        }
      });

      await tx.user.updateMany({
        where: {
          id: input.userId,
          tenantId: input.tenantId
        },
        data: {
          authLockedUntil: lockUntil,
          authLockReason: "refresh_token_reuse_detected"
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          actionType: "AUTH_REFRESH_REUSE_DETECTED",
          moduleName: "AuthModule",
          entityType: "User",
          entityId: input.userId,
          oldValue: {
            authLockedUntil: null,
            authLockReason: null
          },
          newValue: {
            lockUntil: lockUntil.toISOString(),
            reason: "refresh_token_reuse_detected",
            sourceSessionId: input.sessionId,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null
          },
          ipAddress: input.ipAddress,
          deviceInfo: input.userAgent
        }
      });
    });
  }

  private assertUserNotLocked(authLockedUntil: Date | null, reason?: string | null): void {
    if (!authLockedUntil) {
      return;
    }

    if (authLockedUntil > new Date()) {
      throw new UnauthorizedException(
        `Account temporarily locked due to suspicious activity${
          reason ? `: ${reason}` : ""
        }`
      );
    }
  }

  private extractBearerToken(authorization?: string): string | null {
    if (!authorization?.startsWith("Bearer ")) {
      return null;
    }

    return authorization.slice("Bearer ".length).trim();
  }

  private getAccessSecret(): string {
    return process.env.JWT_ACCESS_SECRET ?? "dev-access-secret";
  }

  private getRefreshSecret(): string {
    return process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret";
  }
}
