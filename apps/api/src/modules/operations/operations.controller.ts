import { Body, Controller, DefaultValuePipe, Get, ParseIntPipe, Post, Query, Res } from "@nestjs/common";
import { Response } from "express";
import { UserRole } from "@prisma/client";
import { Roles } from "../../common/auth/roles.decorator";
import { OperationsService } from "./operations.service";

type LiveDashboardResponse = {
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
};

type NotificationDeliveryResponse = {
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

type DeadLetterRetryResponse = {
  dryRun: boolean;
  selected: number;
  wouldEnqueue: number;
  enqueued: number;
  skippedPermanent: number;
  duplicateGroups: number;
};

type EventArchiveResponse = {
  items: Array<{
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
  }>;
  total: number;
};

type EventTriageResponse = {
  action: "acknowledge" | "snooze" | "assign" | "resolve";
  matched: number;
  updated: number;
};

@Controller("operations")
@Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.OPERATOR, UserRole.ACCOUNTANT)
export class OperationsController {
  constructor(private readonly operationsService: OperationsService) {}

  @Get("live-dashboard")
  getLiveDashboard(): Promise<LiveDashboardResponse> {
    return this.operationsService.getLiveDashboard();
  }

  @Get("notification-deliveries")
  getNotificationDeliveries(
    @Query("limit", new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query("status") status?: string,
    @Query("channel") channel?: string,
    @Query("errorCategory") errorCategory?: string,
    @Query("reservationId") reservationId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<NotificationDeliveryResponse> {
    return this.operationsService.getNotificationDeliveries({
      limit,
      offset,
      status,
      channel,
      errorCategory,
      reservationId,
      from,
      to
    });
  }

  @Get("notification-dead-letter")
  getNotificationDeadLetter(
    @Query("limit", new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query("errorCategory") errorCategory?: string,
    @Query("reservationId") reservationId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<NotificationDeliveryResponse> {
    return this.operationsService.getNotificationDeadLetter({
      limit,
      offset,
      errorCategory,
      reservationId,
      from,
      to
    });
  }

  @Get("notification-deliveries/export")
  async exportNotificationDeliveries(
    @Query("format", new DefaultValuePipe("csv")) format: string,
    @Query("limit", new DefaultValuePipe(1000), ParseIntPipe) limit: number,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query("status") status?: string,
    @Query("channel") channel?: string,
    @Query("errorCategory") errorCategory?: string,
    @Query("reservationId") reservationId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Res({ passthrough: true }) response?: Response
  ): Promise<string> {
    const exported = await this.operationsService.exportNotificationDeliveries({
      format,
      limit,
      offset,
      status,
      channel,
      errorCategory,
      reservationId,
      from,
      to
    });

    response?.setHeader("Content-Type", exported.contentType);
    response?.setHeader("Content-Disposition", `attachment; filename="${exported.fileName}"`);
    return exported.body;
  }

  @Post("notification-dead-letter/retry")
  retryNotificationDeadLetter(
    @Body()
    body: {
      deliveryIds?: string[];
      reservationId?: string;
      errorCategory?: string;
      from?: string;
      to?: string;
      limit?: number;
      includePermanent?: boolean;
      dryRun?: boolean;
    }
  ): Promise<DeadLetterRetryResponse> {
    return this.operationsService.retryNotificationDeadLetter(body);
  }

  @Get("event-archive")
  getEventArchive(
    @Query("limit", new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query("eventType") eventType?: string,
    @Query("severity") severity?: string,
    @Query("triageStatus") triageStatus?: string,
    @Query("reservationId") reservationId?: string,
    @Query("assignedUserId") assignedUserId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string
  ): Promise<EventArchiveResponse> {
    return this.operationsService.getEventArchive({
      limit,
      offset,
      eventType,
      severity,
      triageStatus,
      reservationId,
      assignedUserId,
      from,
      to
    });
  }

  @Get("event-archive/export")
  async exportEventArchive(
    @Query("format", new DefaultValuePipe("csv")) format: string,
    @Query("limit", new DefaultValuePipe(1000), ParseIntPipe) limit: number,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query("eventType") eventType?: string,
    @Query("severity") severity?: string,
    @Query("triageStatus") triageStatus?: string,
    @Query("reservationId") reservationId?: string,
    @Query("assignedUserId") assignedUserId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Res({ passthrough: true }) response?: Response
  ): Promise<string> {
    const exported = await this.operationsService.exportEventArchive({
      format,
      limit,
      offset,
      eventType,
      severity,
      triageStatus,
      reservationId,
      assignedUserId,
      from,
      to
    });

    response?.setHeader("Content-Type", exported.contentType);
    response?.setHeader("Content-Disposition", `attachment; filename="${exported.fileName}"`);
    return exported.body;
  }

  @Post("event-archive/triage")
  triageEventArchive(
    @Body()
    body: {
      eventIds: string[];
      action: "acknowledge" | "snooze" | "assign" | "resolve";
      snoozedUntil?: string;
      assignedUserId?: string;
    }
  ): Promise<EventTriageResponse> {
    return this.operationsService.triageEventArchive(body);
  }
}
