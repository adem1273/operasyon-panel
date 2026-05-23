import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { requestContext } from "../context/request-context";

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const tenantId = req.header("x-tenant-id")?.trim();
    const userId = req.header("x-user-id")?.trim();

    requestContext.run({ tenantId, userId }, () => {
      next();
    });
  }
}
