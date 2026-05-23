import { UserRole } from "@prisma/client";

export type RequestUser = {
  userId: string;
  tenantId: string;
  role: UserRole;
  sessionId: string;
};
