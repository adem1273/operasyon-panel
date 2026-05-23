import { Injectable, Logger } from "@nestjs/common";
import { NotificationPayload } from "../notification.service";
import { NotificationDispatchError, NotificationSendResult } from "../notification.types";

@Injectable()
export class WhatsAppProvider {
  private readonly logger = new Logger(WhatsAppProvider.name);

  async send(payload: NotificationPayload): Promise<NotificationSendResult> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const apiVersion = process.env.WHATSAPP_API_VERSION ?? "v20.0";
    const toPhones = this.extractToPhones(payload);

    if (!accessToken || !phoneNumberId || toPhones.length === 0) {
      this.logger.log(
        `WhatsApp skipped tenant=${payload.tenantId} reservation=${payload.reservationId} configured=${Boolean(
          accessToken && phoneNumberId
        )} recipients=${toPhones.length}`
      );
      return {
        outcome: "skipped",
        provider: "WHATSAPP",
        detail: "missing configuration or recipients"
      };
    }

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    let sentCount = 0;

    for (const toPhone of toPhones) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: toPhone,
            type: "text",
            text: {
              body: `${payload.title}\n${payload.message}`
            }
          })
        });
      } catch (error) {
        throw new NotificationDispatchError({
          message: `WhatsApp network error: ${error instanceof Error ? error.message : "unknown"}`,
          category: "transient",
          provider: "WHATSAPP"
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        const category = response.status >= 500 || response.status === 429 ? "transient" : "permanent";
        this.logger.error(
          `WhatsApp send failed tenant=${payload.tenantId} reservation=${payload.reservationId} status=${response.status} body=${errorText}`
        );
        throw new NotificationDispatchError({
          message: `WhatsApp send failed: ${errorText}`,
          category,
          provider: "WHATSAPP",
          statusCode: response.status
        });
      }

      sentCount += 1;
      this.logger.log(
        `WhatsApp sent tenant=${payload.tenantId} reservation=${payload.reservationId} to=${toPhone}`
      );
    }

    return {
      outcome: "sent",
      provider: "WHATSAPP",
      detail: `recipients=${sentCount}`
    };
  }

  private extractToPhones(payload: NotificationPayload): string[] {
    const toPhonesValue = payload.metadata?.toPhones;
    if (Array.isArray(toPhonesValue)) {
      return toPhonesValue.filter(
        (phone): phone is string => typeof phone === "string" && phone.trim().length > 0
      );
    }

    const legacySingle = payload.metadata?.toPhone;
    if (typeof legacySingle === "string" && legacySingle.trim().length > 0) {
      return [legacySingle.trim()];
    }

    return [];
  }
}
