import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "../../modules/auth/auth.service";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { RequestUser } from "./request-user";

type HttpRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: RequestUser;
};

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly prisma: PrismaService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const authorization = request.headers.authorization;
    const token = this.extractBearerToken(authorization);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const payload = await this.authService.verifyAccessToken(token);
    const tenantHeader = this.readHeader(request.headers, "x-tenant-id");

    if (!tenantHeader || tenantHeader !== payload.tenantId) {
      throw new UnauthorizedException("Tenant mismatch");
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

    const userHeader = this.readHeader(request.headers, "x-user-id");
    if (userHeader && userHeader !== user.id) {
      throw new UnauthorizedException("User header mismatch");
    }

    request.user = {
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
      sessionId: payload.sessionId
    };

    return true;
  }

  private extractBearerToken(authorization?: string | string[]): string | null {
    if (!authorization || Array.isArray(authorization)) {
      return null;
    }

    if (!authorization.startsWith("Bearer ")) {
      return null;
    }

    return authorization.slice("Bearer ".length).trim();
  }

  private readHeader(
    headers: Record<string, string | string[] | undefined>,
    key: string
  ): string | null {
    const value = headers[key];
    if (!value) {
      return null;
    }
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return value;
  }
}
