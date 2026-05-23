import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationErrorCategory,
  Prisma,
  ReservationStatus
} from "@prisma/client";
import { getCurrentTenantId } from "../../common/context/request-context";
import { PrismaService } from "../../common/prisma/prisma.service";
import { QueueService } from "../../common/queue/queue.service";

type DeliveryQueryInput = {
  limit: number;
  offset: number;
  status?: string;
  channel?: string;
  errorCategory?: string;
  reservationId?: string;
  from?: string;
  to?: string;
};

type DeliveryQueryResult = {
  items: Array<{
    id: string;
    reservationId: string;
    channel: string;
    status: string;
    errorCategory?: string;
    errorMessage?: string;
    attemptNumber: number;
    queueJobId: string;
    queueJobName: string;
    createdAt: string;
    sentAt?: string;
  }>;
  total: number;
};

type DeliveryExportResult = {
  contentType: string;
  fileName: string;
  body: string;
};

type DeadLetterRetryInput = {
  deliveryIds?: string[];
  reservationId?: string;
  errorCategory?: string;
  from?: string;
  to?: string;
  limit?: number;
  includePermanent?: boolean;
  dryRun?: boolean;
};

type DeadLetterRetryResult = {
  dryRun: boolean;
  selected: number;
  wouldEnqueue: number;
  enqueued: number;
  skippedPermanent: number;
  duplicateGroups: number;
};

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService
  ) {}

  async getLiveDashboard(): Promise<{
    reservationSummary: {
      total: number;
      pendingApproval: number;
      active: number;
      delayed: number;
      completedToday: number;
    };
    recentAlerts: Array<{
      reservationId: string;
      previousStatus: string;
      newStatus: string;
      createdAt: string;
      reason?: string;
    }>;
    generatedAt: string;
  }> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [total, pendingApproval, active, delayed, completedToday, recentAlerts] = await Promise.all([
      this.prisma.reservation.count({
        where: { tenantId, deletedAt: null }
      }),
      this.prisma.reservation.count({
        where: { tenantId, deletedAt: null, status: ReservationStatus.PENDING_APPROVAL }
      }),
      this.prisma.reservation.count({
        where: {
          tenantId,
          deletedAt: null,
          status: {
            in: [
              ReservationStatus.CONFIRMED,
              ReservationStatus.DRIVER_ASSIGNED,
              ReservationStatus.DRIVER_ACCEPTED,
              ReservationStatus.DRIVER_EN_ROUTE,
              ReservationStatus.CUSTOMER_PICKED_UP,
              ReservationStatus.IN_PROGRESS
            ]
          }
        }
      }),
      this.prisma.reservation.count({
        where: { tenantId, deletedAt: null, status: ReservationStatus.DELAYED }
      }),
      this.prisma.reservation.count({
        where: {
          tenantId,
          deletedAt: null,
          status: ReservationStatus.COMPLETED,
          updatedAt: {
            gte: startOfDay
          }
        }
      }),
      this.prisma.reservationStatusLog.findMany({
        where: {
          tenantId,
          OR: [{ newStatus: ReservationStatus.DELAYED }, { newStatus: ReservationStatus.FAILED }]
        },
        orderBy: {
          createdAt: "desc"
        },
        take: 10
      })
    ]);

    return {
      reservationSummary: {
        total,
        pendingApproval,
        active,
        delayed,
        completedToday
      },
      recentAlerts: recentAlerts.map((alert) => ({
        reservationId: alert.reservationId,
        previousStatus: alert.previousStatus,
        newStatus: alert.newStatus,
        createdAt: alert.createdAt.toISOString(),
        reason: alert.reason ?? undefined
      })),
      generatedAt: new Date().toISOString()
    };
  }

  async getNotificationDeliveries(input: DeliveryQueryInput): Promise<DeliveryQueryResult> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const safeLimit = Math.max(1, Math.min(input.limit, 100));
    const safeOffset = Math.max(0, input.offset);
    const where = this.buildDeliveryWhere({
      tenantId,
      status: input.status,
      channel: input.channel,
      errorCategory: input.errorCategory,
      reservationId: input.reservationId,
      from: input.from,
      to: input.to
    });

    const [total, rows] = await Promise.all([
      this.prisma.notificationDelivery.count({
        where
      }),
      this.prisma.notificationDelivery.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: safeLimit,
        skip: safeOffset
      })
    ]);

    return {
      total,
      items: rows.map((row) => this.mapDeliveryRow(row))
    };
  }

  async getNotificationDeadLetter(input: {
    limit: number;
    offset: number;
    errorCategory?: string;
    reservationId?: string;
    from?: string;
    to?: string;
  }): Promise<DeliveryQueryResult> {
    return this.getNotificationDeliveries({
      ...input,
      status: NotificationDeliveryStatus.FAILED
    });
  }

  async exportNotificationDeliveries(input: DeliveryQueryInput & { format?: string }): Promise<DeliveryExportResult> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const format = this.parseExportFormat(input.format);
    const safeLimit = Math.max(1, Math.min(input.limit, 5000));
    const safeOffset = Math.max(0, input.offset);
    const where = this.buildDeliveryWhere({
      tenantId,
      status: input.status,
      channel: input.channel,
      errorCategory: input.errorCategory,
      reservationId: input.reservationId,
      from: input.from,
      to: input.to
    });

    const rows = await this.prisma.notificationDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: safeLimit,
      skip: safeOffset
    });

    const items = rows.map((row) => this.mapDeliveryRow(row));
    const datePart = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      return {
        contentType: "application/json; charset=utf-8",
        fileName: `notification-deliveries-${datePart}.json`,
        body: JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            count: items.length,
            items
          },
          null,
          2
        )
      };
    }

    return {
      contentType: "text/csv; charset=utf-8",
      fileName: `notification-deliveries-${datePart}.csv`,
      body: this.toCsv(items)
    };
  }

  async retryNotificationDeadLetter(input: DeadLetterRetryInput): Promise<DeadLetterRetryResult> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const safeLimit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const includePermanent = Boolean(input.includePermanent);
    const dryRun = Boolean(input.dryRun);

    const where = this.buildDeliveryWhere({
      tenantId,
      status: NotificationDeliveryStatus.FAILED,
      channel: undefined,
      errorCategory: input.errorCategory,
      reservationId: input.reservationId,
      from: input.from,
      to: input.to
    });

    if (input.deliveryIds && input.deliveryIds.length > 0) {
      where.id = { in: input.deliveryIds };
    }

    const rows = await this.prisma.notificationDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: safeLimit
    });

    const grouped = new Map<string, (typeof rows)[number]>();
    let skippedPermanent = 0;
    let duplicateGroups = 0;

    for (const row of rows) {
      if (!includePermanent && row.errorCategory === NotificationErrorCategory.PERMANENT) {
        skippedPermanent += 1;
        continue;
      }

      const groupKey = `${row.queueJobName}:${row.reservationId}`;
      if (grouped.has(groupKey)) {
        duplicateGroups += 1;
        continue;
      }

      grouped.set(groupKey, row);
    }

    const selectedRows = Array.from(grouped.values());

    if (!dryRun) {
      for (const [index, row] of selectedRows.entries()) {
        const metadata = this.readProviderPayload(row.providerPayload);
        const sourceJobId =
          row.sourceJobId ?? (typeof metadata.sourceJobId === "string" ? metadata.sourceJobId : null);

        await this.queueService.enqueueNotificationDispatch(
          row.queueJobName,
          {
            tenantId,
            reservationId: row.reservationId,
            message: `Dead-letter retry for reservation ${row.reservationId}`,
            reason: typeof metadata.reason === "string" ? metadata.reason : null,
            pickupTime: typeof metadata.pickupTime === "string" ? metadata.pickupTime : null,
            sourceJobId
          },
          {
            jobId: `${tenantId}_${row.reservationId}_${row.queueJobName}_retry_${Date.now()}_${index}`
          }
        );
      }
    }

    return {
      dryRun,
      selected: rows.length,
      wouldEnqueue: selectedRows.length,
      enqueued: dryRun ? 0 : selectedRows.length,
      skippedPermanent,
      duplicateGroups
    };
  }

  private buildDeliveryWhere(input: {
    tenantId: string;
    status?: string;
    channel?: string;
    errorCategory?: string;
    reservationId?: string;
    from?: string;
    to?: string;
  }): Prisma.NotificationDeliveryWhereInput {
    const where: Prisma.NotificationDeliveryWhereInput = {
      tenantId: input.tenantId
    };

    if (input.status) {
      where.status = this.parseStatus(input.status);
    }

    if (input.channel) {
      where.channel = this.parseChannel(input.channel);
    }

    if (input.errorCategory) {
      where.errorCategory = this.parseErrorCategory(input.errorCategory);
    }

    if (input.reservationId) {
      where.reservationId = input.reservationId;
    }

    if (input.from || input.to) {
      where.createdAt = {};

      if (input.from) {
        const fromDate = new Date(input.from);
        if (Number.isNaN(fromDate.getTime())) {
          throw new BadRequestException("Invalid from date");
        }
        where.createdAt.gte = fromDate;
      }

      if (input.to) {
        const toDate = new Date(input.to);
        if (Number.isNaN(toDate.getTime())) {
          throw new BadRequestException("Invalid to date");
        }
        where.createdAt.lte = toDate;
      }
    }

    return where;
  }

  private parseStatus(value: string): NotificationDeliveryStatus {
    const upper = value.toUpperCase();
    if (!Object.values(NotificationDeliveryStatus).includes(upper as NotificationDeliveryStatus)) {
      throw new BadRequestException("Invalid status filter");
    }
    return upper as NotificationDeliveryStatus;
  }

  private parseChannel(value: string): NotificationChannel {
    const upper = value.toUpperCase();
    if (!Object.values(NotificationChannel).includes(upper as NotificationChannel)) {
      throw new BadRequestException("Invalid channel filter");
    }
    return upper as NotificationChannel;
  }

  private parseErrorCategory(value: string): NotificationErrorCategory {
    const upper = value.toUpperCase();
    if (!Object.values(NotificationErrorCategory).includes(upper as NotificationErrorCategory)) {
      throw new BadRequestException("Invalid errorCategory filter");
    }
    return upper as NotificationErrorCategory;
  }

  private parseExportFormat(value?: string): "csv" | "json" {
    if (!value) {
      return "csv";
    }

    const lower = value.toLowerCase();
    if (lower !== "csv" && lower !== "json") {
      throw new BadRequestException("Invalid format filter");
    }

    return lower;
  }

  private readProviderPayload(value: Prisma.JsonValue | null): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  private toCsv(items: DeliveryQueryResult["items"]): string {
    const headers = [
      "id",
      "reservationId",
      "channel",
      "status",
      "errorCategory",
      "errorMessage",
      "attemptNumber",
      "queueJobId",
      "queueJobName",
      "createdAt",
      "sentAt"
    ];

    const lines = items.map((item) => {
      const values = [
        item.id,
        item.reservationId,
        item.channel,
        item.status,
        item.errorCategory ?? "",
        item.errorMessage ?? "",
        String(item.attemptNumber),
        item.queueJobId,
        item.queueJobName,
        item.createdAt,
        item.sentAt ?? ""
      ];

      return values.map((value) => this.escapeCsv(value)).join(",");
    });

    return [headers.join(","), ...lines].join("\n");
  }

  private escapeCsv(value: string): string {
    if (value.includes(",") || value.includes("\"") || value.includes("\n") || value.includes("\r")) {
      return `"${value.replace(/\"/g, '""')}"`;
    }

    return value;
  }

  private mapDeliveryRow(row: {
    id: string;
    reservationId: string;
    channel: NotificationChannel;
    status: NotificationDeliveryStatus;
    errorCategory: NotificationErrorCategory | null;
    errorMessage: string | null;
    attemptNumber: number;
    queueJobId: string;
    queueJobName: string;
    createdAt: Date;
    sentAt: Date | null;
  }): DeliveryQueryResult["items"][number] {
    return {
      id: row.id,
      reservationId: row.reservationId,
      channel: row.channel,
      status: row.status,
      errorCategory: row.errorCategory ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      attemptNumber: row.attemptNumber,
      queueJobId: row.queueJobId,
      queueJobName: row.queueJobName,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt?.toISOString()
    };
  }
}
