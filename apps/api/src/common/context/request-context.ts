import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  tenantId?: string;
  userId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getCurrentTenantId(): string | undefined {
  return requestContext.getStore()?.tenantId;
}

export function getCurrentUserId(): string | undefined {
  return requestContext.getStore()?.userId;
}
