import { Injectable } from "@nestjs/common";
import { FcmProvider } from "./providers/fcm.provider";
import { WhatsAppProvider } from "./providers/whatsapp.provider";
import { NotificationRecipientResolverService } from "./recipient-resolver.service";
import { NotificationSendResult } from "./notification.types";

export type NotificationChannel = "FCM" | "WHATSAPP";

export type NotificationPayload = {
  tenantId: string;
  reservationId: string;
  title: string;
  message: string;
  targetUserIds?: string[];
  metadata?: Record<string, unknown>;
};

@Injectable()
export class NotificationService {
  constructor(
    private readonly fcmProvider: FcmProvider,
    private readonly whatsappProvider: WhatsAppProvider,
    private readonly recipientResolver: NotificationRecipientResolverService
  ) {}

  async send(channel: NotificationChannel, payload: NotificationPayload): Promise<NotificationSendResult> {
    const recipients = await this.recipientResolver.resolve({
      tenantId: payload.tenantId,
      targetUserIds: payload.targetUserIds
    });

    const enrichedPayload: NotificationPayload = {
      ...payload,
      metadata: {
        ...(payload.metadata ?? {}),
        deviceTokens: recipients.deviceTokens,
        toPhones: recipients.phones
      }
    };

    if (channel === "FCM") {
      return this.fcmProvider.send(enrichedPayload);
    }

    return this.whatsappProvider.send(enrichedPayload);
  }
}
