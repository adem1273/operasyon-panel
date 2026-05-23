export type NotificationSendOutcome = "sent" | "skipped";
export type NotificationErrorCategory = "transient" | "permanent";

export class NotificationDispatchError extends Error {
  readonly category: NotificationErrorCategory;
  readonly provider: "FCM" | "WHATSAPP";
  readonly statusCode?: number;

  constructor(input: {
    message: string;
    category: NotificationErrorCategory;
    provider: "FCM" | "WHATSAPP";
    statusCode?: number;
  }) {
    super(input.message);
    this.name = "NotificationDispatchError";
    this.category = input.category;
    this.provider = input.provider;
    this.statusCode = input.statusCode;
  }
}

export type NotificationSendResult = {
  outcome: NotificationSendOutcome;
  provider: "FCM" | "WHATSAPP";
  detail?: string;
};
