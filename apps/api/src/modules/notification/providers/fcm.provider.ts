import { Injectable, Logger } from "@nestjs/common";
import { NotificationPayload } from "../notification.service";
import { NotificationDispatchError, NotificationSendResult } from "../notification.types";

@Injectable()
export class FcmProvider {
  private readonly logger = new Logger(FcmProvider.name);
  private readonly endpoint = "https://fcm.googleapis.com/fcm/send";

  async send(payload: NotificationPayload): Promise<NotificationSendResult> {
    const serverKey = process.env.FCM_SERVER_KEY;
    const deviceTokens = this.extractDeviceTokens(payload);

    if (!serverKey || deviceTokens.length === 0) {
      this.logger.log(
        `FCM skipped tenant=${payload.tenantId} reservation=${payload.reservationId} configured=${Boolean(
          serverKey
        )} tokens=${deviceTokens.length}`
      );
      return {
        outcome: "skipped",
        provider: "FCM",
        detail: "missing configuration or recipients"
      };
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `key=${serverKey}`
        },
        body: JSON.stringify({
          registration_ids: deviceTokens,
          notification: {
            title: payload.title,
            body: payload.message
          },
          data: {
            tenantId: payload.tenantId,
            reservationId: payload.reservationId,
            ...(payload.metadata ?? {})
          }
        })
      });
    } catch (error) {
      throw new NotificationDispatchError({
        message: `FCM network error: ${error instanceof Error ? error.message : "unknown"}`,
        category: "transient",
        provider: "FCM"
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      const category = response.status >= 500 || response.status === 429 ? "transient" : "permanent";
      this.logger.error(
        `FCM send failed tenant=${payload.tenantId} reservation=${payload.reservationId} status=${response.status} body=${errorText}`
      );
      throw new NotificationDispatchError({
        message: `FCM send failed: ${errorText}`,
        category,
        provider: "FCM",
        statusCode: response.status
      });
    }

    this.logger.log(
      `FCM sent tenant=${payload.tenantId} reservation=${payload.reservationId} tokens=${deviceTokens.length}`
    );

    return {
      outcome: "sent",
      provider: "FCM",
      detail: `tokens=${deviceTokens.length}`
    };
  }

  private extractDeviceTokens(payload: NotificationPayload): string[] {
    const candidate = payload.metadata?.deviceTokens;
    if (!Array.isArray(candidate)) {
      return [];
    }

    return candidate.filter((token): token is string => typeof token === "string" && token.length > 0);
  }
}
