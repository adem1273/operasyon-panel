import { Injectable } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";

export type ResolvedRecipients = {
  deviceTokens: string[];
  phones: string[];
};

@Injectable()
export class NotificationRecipientResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: {
    tenantId: string;
    targetUserIds?: string[];
  }): Promise<ResolvedRecipients> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId: input.tenantId,
        isActive: true,
        deletedAt: null,
        ...(input.targetUserIds && input.targetUserIds.length > 0
          ? {
              id: {
                in: input.targetUserIds
              }
            }
          : {
              role: {
                in: [UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.OPERATOR]
              }
            })
      },
      select: {
        phoneE164: true,
        userDevices: {
          where: {
            isActive: true
          },
          select: {
            token: true
          }
        }
      }
    });

    const phoneSet = new Set<string>();
    const tokenSet = new Set<string>();

    for (const user of users) {
      if (user.phoneE164) {
        phoneSet.add(user.phoneE164);
      }

      for (const device of user.userDevices) {
        tokenSet.add(device.token);
      }
    }

    return {
      deviceTokens: [...tokenSet],
      phones: [...phoneSet]
    };
  }
}
