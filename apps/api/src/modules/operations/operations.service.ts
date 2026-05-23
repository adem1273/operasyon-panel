import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  AlarmTriageStatus,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationErrorCategory,
  OperationalEventSeverity,
  OperationalEventType,
  Prisma,
  ReservationStatus
} from "@prisma/client";
import { getCurrentTenantId, getCurrentUserId } from "../../common/context/request-context";
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

type EventArchiveQueryInput = {
  limit: number;
  offset: number;
  cursorId?: string;
  eventType?: string;
  severity?: string;
  triageStatus?: string;
  reservationId?: string;
  assignedUserId?: string;
  from?: string;
  to?: string;
};

type EventArchiveRow = {
  id: string;
  reservationId?: string;
  eventType: string;
  severity: string;
  title: string;
  detail: string;
  eventAt: string;
  triageStatus: string;
  acknowledgedAt?: string;
  acknowledgedByUserId?: string;
  snoozedUntil?: string;
  assignedUserId?: string;
};

type EventArchiveQueryResult = {
  items: EventArchiveRow[];
  total?: number;
  nextCursorId?: string;
};

type EventArchiveExportResult = {
  contentType: string;
  fileName: string;
  body: string;
};

type EventTriageAction = "acknowledge" | "snooze" | "assign" | "resolve";

type EventTriageInput = {
  eventIds: string[];
  action: EventTriageAction;
  snoozedUntil?: string;
  assignedUserId?: string;
};

type EventTriageResult = {
  action: EventTriageAction;
  matched: number;
  updated: number;
};

type OperationsMetricsSnapshot = {
  generatedAt: string;
  eventArchiveQueryCount: number;
  eventArchiveQueryLatencyMsAvg: number;
  triageActionCount: number;
  triageActionLatencyMsAvg: number;
  triageFailureCount: number;
  triageActionBreakdown: {
    acknowledge: number;
    snooze: number;
    assign: number;
    resolve: number;
  };
};

@Injectable()
export class OperationsService {
  private readonly metrics = {
    eventArchiveQueryCount: 0,
    eventArchiveQueryLatencyMsTotal: 0,
    triageActionCount: 0,
    triageActionLatencyMsTotal: 0,
    triageFailureCount: 0,
    triageActionBreakdown: {
      acknowledge: 0,
      snooze: 0,
      assign: 0,
      resolve: 0
    }
  };

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

  async getEventArchive(input: EventArchiveQueryInput): Promise<EventArchiveQueryResult> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const startedAt = Date.now();
    const safeLimit = Math.max(1, Math.min(input.limit, 200));
    const safeOffset = Math.max(0, input.offset);
    const baseWhere = this.buildEventArchiveWhere({
      tenantId,
      eventType: input.eventType,
      severity: input.severity,
      triageStatus: input.triageStatus,
      reservationId: input.reservationId,
      assignedUserId: input.assignedUserId,
      from: input.from,
      to: input.to
    });

    const where = await this.withCursorWhere(tenantId, baseWhere, input.cursorId);

    const rows = await this.prisma.operationalEvent.findMany({
      where,
      orderBy: [{ eventAt: "desc" }, { id: "desc" }],
      take: safeLimit + 1,
      skip: input.cursorId ? 0 : safeOffset
    });

    const hasMore = rows.length > safeLimit;
    const pagedRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const total = input.cursorId ? undefined : await this.prisma.operationalEvent.count({ where: baseWhere });

    this.observeEventArchiveQuery(Date.now() - startedAt);

    return {
      total,
      nextCursorId: hasMore ? pagedRows[pagedRows.length - 1]?.id : undefined,
      items: pagedRows.map((row) => this.mapEventArchiveRow(row))
    };
  }

  async exportEventArchive(input: EventArchiveQueryInput & { format?: string }): Promise<EventArchiveExportResult> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const format = this.parseExportFormat(input.format);
    const safeLimit = Math.max(1, Math.min(input.limit, 5000));
    const safeOffset = Math.max(0, input.offset);
    const where = this.buildEventArchiveWhere({
      tenantId,
      eventType: input.eventType,
      severity: input.severity,
      triageStatus: input.triageStatus,
      reservationId: input.reservationId,
      assignedUserId: input.assignedUserId,
      from: input.from,
      to: input.to
    });

    const rows = await this.prisma.operationalEvent.findMany({
      where,
      orderBy: [{ triageStatus: "asc" }, { severity: "desc" }, { eventAt: "desc" }],
      take: safeLimit,
      skip: safeOffset
    });

    const items = rows.map((row) => this.mapEventArchiveRow(row));
    const datePart = new Date().toISOString().slice(0, 10);

    if (format === "json") {
      return {
        contentType: "application/json; charset=utf-8",
        fileName: `event-archive-${datePart}.json`,
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
      fileName: `event-archive-${datePart}.csv`,
      body: this.toEventArchiveCsv(items)
    };
  }

  async triageEventArchive(input: EventTriageInput): Promise<EventTriageResult> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const userId = getCurrentUserId();
    if (!userId) {
      throw new UnauthorizedException("Missing user context");
    }

    if (!Array.isArray(input.eventIds) || input.eventIds.length === 0) {
      throw new BadRequestException("eventIds is required");
    }

    const uniqueEventIds = Array.from(new Set(input.eventIds.map((value) => value.trim()).filter(Boolean)));
    if (uniqueEventIds.length === 0) {
      throw new BadRequestException("eventIds is required");
    }

    const action = input.action;
    const startedAt = Date.now();
    const rows = await this.prisma.operationalEvent.findMany({
      where: {
        tenantId,
        id: { in: uniqueEventIds }
      },
      select: {
        id: true,
        triageStatus: true,
        assignedUserId: true,
        snoozedUntil: true,
        acknowledgedByUserId: true,
        acknowledgedAt: true
      }
    });

    const matched = rows.length;

    if (matched === 0) {
      return {
        action,
        matched,
        updated: 0
      };
    }

    const data = this.buildTriageUpdateData(action, userId, input);
    const updates = rows.map((row) =>
      this.prisma.operationalEvent.update({
        where: {
          id: row.id
        },
        data
      })
    );

    const triageAuditAction = `OP_EVENT_TRIAGE_${action.toUpperCase()}`;
    const newValue = this.buildTriageAuditNewValue(action, input, userId);
    const auditLogs = rows.map((row) =>
      this.prisma.auditLog.create({
        data: {
          tenantId,
          userId,
          actionType: triageAuditAction,
          moduleName: "OperationsModule",
          entityType: "OperationalEvent",
          entityId: row.id,
          oldValue: {
            triageStatus: row.triageStatus,
            assignedUserId: row.assignedUserId,
            snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
            acknowledgedByUserId: row.acknowledgedByUserId,
            acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null
          },
          newValue
        }
      })
    );

    let updated;
    try {
      updated = await this.prisma.$transaction([...updates, ...auditLogs]);
      this.observeTriageAction(action, Date.now() - startedAt, false);
    } catch (error) {
      this.observeTriageAction(action, Date.now() - startedAt, true);
      throw error;
    }

    return {
      action,
      matched,
      updated: updated.length - auditLogs.length
    };
  }

  getMetrics(): OperationsMetricsSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      eventArchiveQueryCount: this.metrics.eventArchiveQueryCount,
      eventArchiveQueryLatencyMsAvg: this.average(
        this.metrics.eventArchiveQueryLatencyMsTotal,
        this.metrics.eventArchiveQueryCount
      ),
      triageActionCount: this.metrics.triageActionCount,
      triageActionLatencyMsAvg: this.average(
        this.metrics.triageActionLatencyMsTotal,
        this.metrics.triageActionCount
      ),
      triageFailureCount: this.metrics.triageFailureCount,
      triageActionBreakdown: {
        acknowledge: this.metrics.triageActionBreakdown.acknowledge,
        snooze: this.metrics.triageActionBreakdown.snooze,
        assign: this.metrics.triageActionBreakdown.assign,
        resolve: this.metrics.triageActionBreakdown.resolve
      }
    };
  }

  async recordReservationCreatedEvent(payload: {
    tenantId: string;
    reservationId: string;
    pickupTime: string;
  }): Promise<void> {
    await this.prisma.operationalEvent.create({
      data: {
        tenantId: payload.tenantId,
        reservationId: payload.reservationId,
        eventType: OperationalEventType.RESERVATION_CREATED,
        severity: OperationalEventSeverity.LOW,
        title: "Reservation created",
        detail: `Reservation ${payload.reservationId} olusturuldu. Pickup ${payload.pickupTime}`,
        eventAt: new Date(),
        metadata: {
          pickupTime: payload.pickupTime
        },
        triageStatus: AlarmTriageStatus.OPEN
      }
    });
  }

  async recordReservationStatusUpdatedEvent(payload: {
    tenantId: string;
    reservationId: string;
    previousStatus: string;
    nextStatus: string;
    reason?: string;
  }): Promise<void> {
    const severity = this.severityByReservationStatus(payload.nextStatus);

    await this.prisma.operationalEvent.create({
      data: {
        tenantId: payload.tenantId,
        reservationId: payload.reservationId,
        eventType: OperationalEventType.RESERVATION_STATUS_UPDATED,
        severity,
        title: `Status ${payload.previousStatus} -> ${payload.nextStatus}`,
        detail: payload.reason
          ? `Reservation ${payload.reservationId} status degisti (${payload.reason})`
          : `Reservation ${payload.reservationId} status degisti`,
        eventAt: new Date(),
        metadata: {
          previousStatus: payload.previousStatus,
          nextStatus: payload.nextStatus,
          reason: payload.reason ?? null
        },
        triageStatus: severity === OperationalEventSeverity.HIGH ? AlarmTriageStatus.OPEN : AlarmTriageStatus.OPEN
      }
    });
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

  private buildEventArchiveWhere(input: {
    tenantId: string;
    eventType?: string;
    severity?: string;
    triageStatus?: string;
    reservationId?: string;
    assignedUserId?: string;
    from?: string;
    to?: string;
  }): Prisma.OperationalEventWhereInput {
    const where: Prisma.OperationalEventWhereInput = {
      tenantId: input.tenantId
    };

    if (input.eventType) {
      where.eventType = this.parseEventType(input.eventType);
    }

    if (input.severity) {
      where.severity = this.parseEventSeverity(input.severity);
    }

    if (input.triageStatus) {
      where.triageStatus = this.parseTriageStatus(input.triageStatus);
    }

    if (input.reservationId) {
      where.reservationId = input.reservationId;
    }

    if (input.assignedUserId) {
      where.assignedUserId = input.assignedUserId;
    }

    if (input.from || input.to) {
      where.eventAt = {};

      if (input.from) {
        const fromDate = new Date(input.from);
        if (Number.isNaN(fromDate.getTime())) {
          throw new BadRequestException("Invalid from date");
        }
        where.eventAt.gte = fromDate;
      }

      if (input.to) {
        const toDate = new Date(input.to);
        if (Number.isNaN(toDate.getTime())) {
          throw new BadRequestException("Invalid to date");
        }
        where.eventAt.lte = toDate;
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

  private parseEventType(value: string): OperationalEventType {
    const upper = value.toUpperCase();
    if (!Object.values(OperationalEventType).includes(upper as OperationalEventType)) {
      throw new BadRequestException("Invalid eventType filter");
    }
    return upper as OperationalEventType;
  }

  private parseEventSeverity(value: string): OperationalEventSeverity {
    const upper = value.toUpperCase();
    if (!Object.values(OperationalEventSeverity).includes(upper as OperationalEventSeverity)) {
      throw new BadRequestException("Invalid severity filter");
    }
    return upper as OperationalEventSeverity;
  }

  private parseTriageStatus(value: string): AlarmTriageStatus {
    const upper = value.toUpperCase();
    if (!Object.values(AlarmTriageStatus).includes(upper as AlarmTriageStatus)) {
      throw new BadRequestException("Invalid triageStatus filter");
    }
    return upper as AlarmTriageStatus;
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

  private buildTriageUpdateData(
    action: EventTriageAction,
    userId: string,
    input: EventTriageInput
  ): Prisma.OperationalEventUncheckedUpdateInput {
    if (action === "acknowledge") {
      return {
        triageStatus: AlarmTriageStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        acknowledgedByUserId: userId,
        snoozedUntil: null
      };
    }

    if (action === "resolve") {
      return {
        triageStatus: AlarmTriageStatus.RESOLVED,
        acknowledgedAt: new Date(),
        acknowledgedByUserId: userId,
        snoozedUntil: null
      };
    }

    if (action === "assign") {
      if (!input.assignedUserId) {
        throw new BadRequestException("assignedUserId is required for assign action");
      }

      return {
        triageStatus: AlarmTriageStatus.ACKNOWLEDGED,
        assignedUserId: input.assignedUserId,
        acknowledgedAt: new Date(),
        acknowledgedByUserId: userId,
        snoozedUntil: null
      };
    }

    if (action === "snooze") {
      if (!input.snoozedUntil) {
        throw new BadRequestException("snoozedUntil is required for snooze action");
      }

      const snoozedUntil = new Date(input.snoozedUntil);
      if (Number.isNaN(snoozedUntil.getTime())) {
        throw new BadRequestException("Invalid snoozedUntil value");
      }

      return {
        triageStatus: AlarmTriageStatus.SNOOZED,
        snoozedUntil,
        acknowledgedAt: new Date(),
        acknowledgedByUserId: userId
      };
    }

    throw new BadRequestException("Invalid triage action");
  }

  private buildTriageAuditNewValue(
    action: EventTriageAction,
    input: EventTriageInput,
    userId: string
  ): Prisma.InputJsonValue {
    const base: Record<string, unknown> = {
      action,
      changedByUserId: userId,
      changedAt: new Date().toISOString()
    };

    if (action === "assign") {
      base.assignedUserId = input.assignedUserId ?? null;
    }

    if (action === "snooze") {
      base.snoozedUntil = input.snoozedUntil ?? null;
    }

    return base as Prisma.InputJsonValue;
  }

  private async withCursorWhere(
    tenantId: string,
    where: Prisma.OperationalEventWhereInput,
    cursorId?: string
  ): Promise<Prisma.OperationalEventWhereInput> {
    if (!cursorId) {
      return where;
    }

    const cursorRow = await this.prisma.operationalEvent.findFirst({
      where: {
        tenantId,
        id: cursorId
      },
      select: {
        id: true,
        eventAt: true
      }
    });

    if (!cursorRow) {
      return where;
    }

    return {
      AND: [
        where,
        {
          OR: [
            { eventAt: { lt: cursorRow.eventAt } },
            { eventAt: cursorRow.eventAt, id: { lt: cursorRow.id } }
          ]
        }
      ]
    };
  }

  private observeEventArchiveQuery(durationMs: number): void {
    this.metrics.eventArchiveQueryCount += 1;
    this.metrics.eventArchiveQueryLatencyMsTotal += durationMs;
  }

  private observeTriageAction(action: EventTriageAction, durationMs: number, failed: boolean): void {
    this.metrics.triageActionCount += 1;
    this.metrics.triageActionLatencyMsTotal += durationMs;
    this.metrics.triageActionBreakdown[action] += 1;

    if (failed) {
      this.metrics.triageFailureCount += 1;
    }
  }

  private average(total: number, count: number): number {
    if (count === 0) {
      return 0;
    }

    return Number((total / count).toFixed(2));
  }

  private severityByReservationStatus(status: string): OperationalEventSeverity {
    const upper = status.toUpperCase();
    if (["FAILED", "CANCELLED", "NO_SHOW", "DELAYED"].includes(upper)) {
      return OperationalEventSeverity.HIGH;
    }

    if (["DRIVER_EN_ROUTE", "CUSTOMER_PICKED_UP", "IN_PROGRESS"].includes(upper)) {
      return OperationalEventSeverity.MEDIUM;
    }

    return OperationalEventSeverity.LOW;
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

  private toEventArchiveCsv(items: EventArchiveRow[]): string {
    const headers = [
      "id",
      "reservationId",
      "eventType",
      "severity",
      "title",
      "detail",
      "eventAt",
      "triageStatus",
      "acknowledgedAt",
      "acknowledgedByUserId",
      "snoozedUntil",
      "assignedUserId"
    ];

    const lines = items.map((item) => {
      const values = [
        item.id,
        item.reservationId ?? "",
        item.eventType,
        item.severity,
        item.title,
        item.detail,
        item.eventAt,
        item.triageStatus,
        item.acknowledgedAt ?? "",
        item.acknowledgedByUserId ?? "",
        item.snoozedUntil ?? "",
        item.assignedUserId ?? ""
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

  private mapEventArchiveRow(row: {
    id: string;
    reservationId: string | null;
    eventType: OperationalEventType;
    severity: OperationalEventSeverity;
    title: string;
    detail: string;
    eventAt: Date;
    triageStatus: AlarmTriageStatus;
    acknowledgedAt: Date | null;
    acknowledgedByUserId: string | null;
    snoozedUntil: Date | null;
    assignedUserId: string | null;
  }): EventArchiveRow {
    return {
      id: row.id,
      reservationId: row.reservationId ?? undefined,
      eventType: row.eventType,
      severity: row.severity,
      title: row.title,
      detail: row.detail,
      eventAt: row.eventAt.toISOString(),
      triageStatus: row.triageStatus,
      acknowledgedAt: row.acknowledgedAt?.toISOString(),
      acknowledgedByUserId: row.acknowledgedByUserId ?? undefined,
      snoozedUntil: row.snoozedUntil?.toISOString(),
      assignedUserId: row.assignedUserId ?? undefined
    };
  }
}
