import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { JobsOptions, Queue } from "bullmq";
import IORedis from "ioredis";
import { QueueNames } from "./queue.constants";

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

  private readonly connection = new IORedis(this.redisUrl, {
    maxRetriesPerRequest: null
  });

  private readonly reservationEventsQueue = new Queue(QueueNames.ReservationEvents, {
    connection: this.connection,
    defaultJobOptions: {
      attempts: 5,
      removeOnComplete: 200,
      backoff: {
        type: "exponential",
        delay: 2000
      }
    }
  });

  private readonly notificationDispatchQueue = new Queue(QueueNames.NotificationDispatch, {
    connection: this.connection,
    defaultJobOptions: {
      attempts: 5,
      removeOnComplete: 200,
      backoff: {
        type: "exponential",
        delay: 2000
      }
    }
  });

  async enqueueReservationCreated(payload: {
    tenantId: string;
    reservationId: string;
    pickupTime: string;
  }): Promise<void> {
    const options: JobsOptions = {
      jobId: `${payload.tenantId}_${payload.reservationId}`
    };

    await this.reservationEventsQueue.add("reservation.created", payload, options);
  }

  async enqueueReservationStatusUpdated(payload: {
    tenantId: string;
    reservationId: string;
    previousStatus: string;
    nextStatus: string;
    reason?: string;
  }): Promise<void> {
    const options: JobsOptions = {
      jobId: `${payload.tenantId}_${payload.reservationId}_status_${payload.nextStatus}_${Date.now()}`
    };

    await this.reservationEventsQueue.add("reservation.status.updated", payload, options);
  }

  async enqueueNotificationDispatch(
    jobName: string,
    payload: {
      tenantId: string;
      reservationId: string;
      message?: string;
      reason?: string | null;
      pickupTime?: string | null;
      sourceJobId?: string | null;
    },
    options?: JobsOptions
  ): Promise<void> {
    await this.notificationDispatchQueue.add(jobName, payload, options);
  }

  async onModuleDestroy(): Promise<void> {
    await this.reservationEventsQueue.close();
    await this.notificationDispatchQueue.close();
    await this.connection.quit();
  }

  logRedisTarget(): void {
    this.logger.log(`Queue service configured for ${this.redisUrl}`);
  }
}
