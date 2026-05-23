import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { QueueNames } from "./queue.constants";
import { NotificationService } from "../../modules/notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationDispatchError } from "../../modules/notification/notification.types";
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationErrorCategory
} from "@prisma/client";

type ReservationCreatedPayload = {
  tenantId: string;
  reservationId: string;
  pickupTime: string;
};

type ReservationStatusUpdatedPayload = {
  tenantId: string;
  reservationId: string;
  previousStatus: string;
  nextStatus: string;
  reason?: string;
};

@Injectable()
export class QueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkerService.name);
  private readonly redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

  private readonly workerConnection = new IORedis(this.redisUrl, {
    maxRetriesPerRequest: null
  });

  private readonly queueConnection = new IORedis(this.redisUrl, {
    maxRetriesPerRequest: null
  });

  private readonly notificationQueue = new Queue(QueueNames.NotificationDispatch, {
    connection: this.queueConnection,
    defaultJobOptions: {
      attempts: 5,
      removeOnComplete: 200,
      backoff: {
        type: "exponential",
        delay: 2000
      }
    }
  });

  private readonly reservationWorker = new Worker(
    QueueNames.ReservationEvents,
    async (job) => {
      if (job.name === "reservation.created") {
        const payload = job.data as ReservationCreatedPayload;
        await this.handleReservationCreated(job, payload);
        return;
      }

      if (job.name === "reservation.status.updated") {
        const payload = job.data as ReservationStatusUpdatedPayload;
        await this.handleReservationStatusUpdated(job, payload);
        return;
      }

      if (job.name !== "reservation.created" && job.name !== "reservation.status.updated") {
        this.logger.warn(`Unhandled reservation event job: ${job.name}`);
      }
    },
    {
      connection: this.workerConnection,
      concurrency: 10
    }
  );

  private readonly notificationWorker = new Worker(
    QueueNames.NotificationDispatch,
    async (job) => {
      await this.dispatchNotificationJob(job);
    },
    {
      connection: this.workerConnection,
      concurrency: 20
    }
  );

  constructor(
    private readonly notificationService: NotificationService,
    private readonly prisma: PrismaService
  ) {}

  async onModuleInit(): Promise<void> {
    this.reservationWorker.on("failed", (job, error) => {
      this.logger.error(
        `Reservation worker failed job=${job?.id ?? "unknown"} name=${job?.name ?? "unknown"}: ${error.message}`
      );
    });

    this.notificationWorker.on("failed", (job, error) => {
      this.logger.error(
        `Notification worker failed job=${job?.id ?? "unknown"} name=${job?.name ?? "unknown"}: ${error.message}`
      );
    });

    this.logger.log(`Queue workers started on ${this.redisUrl}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.reservationWorker.close();
    await this.notificationWorker.close();
    await this.notificationQueue.close();
    await this.workerConnection.quit();
    await this.queueConnection.quit();
  }

  private async handleReservationCreated(
    job: Job,
    payload: ReservationCreatedPayload
  ): Promise<void> {
    await this.notificationQueue.add(
      "driver.assignment.pending",
      {
        tenantId: payload.tenantId,
        reservationId: payload.reservationId,
        pickupTime: payload.pickupTime,
        sourceJobId: job.id ?? null
      },
      {
        jobId: `${payload.tenantId}_${payload.reservationId}_driver.assignment.pending`
      }
    );
  }

  private async handleReservationStatusUpdated(
    job: Job,
    payload: ReservationStatusUpdatedPayload
  ): Promise<void> {
    const message = `Reservation ${payload.reservationId} moved from ${payload.previousStatus} to ${payload.nextStatus}`;

    await this.notificationQueue.add(
      "reservation.status.changed",
      {
        tenantId: payload.tenantId,
        reservationId: payload.reservationId,
        message,
        reason: payload.reason ?? null,
        sourceJobId: job.id ?? null
      },
      {
        jobId: `${payload.tenantId}_${payload.reservationId}_status.changed_${job.id ?? Date.now()}`
      }
    );
  }

  private async dispatchNotificationJob(job: Job): Promise<void> {
    const tenantId = String(job.data?.tenantId ?? "");
    const reservationId = String(job.data?.reservationId ?? "");

    if (!tenantId || !reservationId) {
      this.logger.warn(`Invalid notification job payload job=${job.name}`);
      return;
    }

    const payload = {
      tenantId,
      reservationId,
      title: job.name,
      message: String(job.data?.message ?? "Operational notification"),
      metadata: {
        sourceJobId: job.data?.sourceJobId ?? null,
        reason: job.data?.reason ?? null,
        pickupTime: job.data?.pickupTime ?? null
      }
    };

    const attemptNumber = job.attemptsMade + 1;
    const queueJobId = String(job.id ?? "unknown");

    const transientErrors: Array<{ channel: NotificationChannel; error: Error }> = [];

    for (const channel of [NotificationChannel.FCM, NotificationChannel.WHATSAPP]) {
      try {
        const result = await this.notificationService.send(channel, payload);

        await this.prisma.notificationDelivery.create({
          data: {
            tenantId,
            reservationId,
            channel,
            status:
              result.outcome === "sent"
                ? NotificationDeliveryStatus.SENT
                : NotificationDeliveryStatus.SKIPPED,
            attemptNumber,
            queueJobId,
            queueJobName: job.name,
            sourceJobId: job.data?.sourceJobId ? String(job.data.sourceJobId) : null,
            providerPayload: payload.metadata,
            providerResponse: {
              outcome: result.outcome,
              detail: result.detail ?? null
            },
            sentAt: result.outcome === "sent" ? new Date() : null
          }
        });
      } catch (error) {
        const mapped = this.mapNotificationError(error);

        await this.prisma.notificationDelivery.create({
          data: {
            tenantId,
            reservationId,
            channel,
            status: NotificationDeliveryStatus.FAILED,
            errorCategory: mapped.category,
            errorMessage: mapped.message,
            attemptNumber,
            queueJobId,
            queueJobName: job.name,
            sourceJobId: job.data?.sourceJobId ? String(job.data.sourceJobId) : null,
            providerPayload: payload.metadata,
            providerResponse: {
              errorName: mapped.name,
              statusCode: mapped.statusCode ?? null
            },
            sentAt: null
          }
        });

        if (mapped.category === NotificationErrorCategory.TRANSIENT) {
          transientErrors.push({ channel, error: mapped });
        }
      }
    }

    if (transientErrors.length > 0) {
      throw transientErrors[0].error;
    }
  }

  private mapNotificationError(error: unknown): Error & {
    category: NotificationErrorCategory;
    statusCode?: number;
  } {
    if (error instanceof NotificationDispatchError) {
      return Object.assign(error, {
        category:
          error.category === "transient"
            ? NotificationErrorCategory.TRANSIENT
            : NotificationErrorCategory.PERMANENT
      });
    }

    const fallback = error instanceof Error ? error : new Error("Unknown notification error");
    return Object.assign(fallback, {
      category: NotificationErrorCategory.TRANSIENT
    });
  }
}
