import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ReservationStatus as PrismaReservationStatus } from "@prisma/client";
import { getCurrentTenantId, getCurrentUserId } from "../../common/context/request-context";
import { PrismaService } from "../../common/prisma/prisma.service";
import { QueueService } from "../../common/queue/queue.service";
import { RealtimeGateway } from "../../common/realtime/realtime.gateway";
import { OperationsService } from "../operations/operations.service";
import { CreateReservationDto } from "./dto/create-reservation.dto";
import { ReservationStatus } from "./reservation.status";
import { UpdateReservationStatusDto } from "./dto/update-reservation-status.dto";

type ReservationEntity = {
  id: string;
  tenantId: string;
  customerName: string;
  pickupLocation: string;
  dropoffLocation: string;
  pickupTime: string;
  status: ReservationStatus;
};

const ALLOWED_TRANSITIONS: Record<ReservationStatus, Set<ReservationStatus>> = {
  [ReservationStatus.PENDING_APPROVAL]: new Set([
    ReservationStatus.CONFIRMED,
    ReservationStatus.CANCELLED,
    ReservationStatus.FAILED
  ]),
  [ReservationStatus.CONFIRMED]: new Set([
    ReservationStatus.DRIVER_ASSIGNED,
    ReservationStatus.CANCELLED,
    ReservationStatus.DELAYED
  ]),
  [ReservationStatus.DRIVER_ASSIGNED]: new Set([
    ReservationStatus.DRIVER_ACCEPTED,
    ReservationStatus.CANCELLED,
    ReservationStatus.DELAYED,
    ReservationStatus.FAILED
  ]),
  [ReservationStatus.DRIVER_ACCEPTED]: new Set([
    ReservationStatus.DRIVER_EN_ROUTE,
    ReservationStatus.CANCELLED,
    ReservationStatus.DELAYED
  ]),
  [ReservationStatus.DRIVER_EN_ROUTE]: new Set([
    ReservationStatus.CUSTOMER_PICKED_UP,
    ReservationStatus.NO_SHOW,
    ReservationStatus.DELAYED
  ]),
  [ReservationStatus.CUSTOMER_PICKED_UP]: new Set([ReservationStatus.IN_PROGRESS]),
  [ReservationStatus.IN_PROGRESS]: new Set([
    ReservationStatus.COMPLETED,
    ReservationStatus.FAILED,
    ReservationStatus.DELAYED
  ]),
  [ReservationStatus.COMPLETED]: new Set(),
  [ReservationStatus.CANCELLED]: new Set(),
  [ReservationStatus.NO_SHOW]: new Set(),
  [ReservationStatus.DELAYED]: new Set([
    ReservationStatus.DRIVER_EN_ROUTE,
    ReservationStatus.CUSTOMER_PICKED_UP,
    ReservationStatus.IN_PROGRESS,
    ReservationStatus.CANCELLED,
    ReservationStatus.FAILED
  ]),
  [ReservationStatus.FAILED]: new Set()
};

@Injectable()
export class ReservationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly operationsService: OperationsService
  ) {}

  async list(): Promise<ReservationEntity[]> {
    const tenantId = getCurrentTenantId();

    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const reservations = await this.prisma.reservation.findMany({
      where: {
        tenantId,
        deletedAt: null
      },
      orderBy: {
        pickupTime: "asc"
      }
    });

    return reservations.map((reservation) => ({
      id: reservation.id,
      tenantId: reservation.tenantId,
      customerName: reservation.customerName,
      pickupLocation: reservation.pickupLocation,
      dropoffLocation: reservation.dropoffLocation,
      pickupTime: reservation.pickupTime.toISOString(),
      status: reservation.status as ReservationStatus
    }));
  }

  async create(dto: CreateReservationDto): Promise<ReservationEntity> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const reservation = await this.prisma.reservation.create({
      data: {
        tenantId,
        customerName: dto.customerName,
        pickupLocation: dto.pickupLocation,
        dropoffLocation: dto.dropoffLocation,
        pickupTime: new Date(dto.pickupTime),
        status: PrismaReservationStatus.PENDING_APPROVAL
      }
    });

    await this.queueService.enqueueReservationCreated({
      tenantId,
      reservationId: reservation.id,
      pickupTime: reservation.pickupTime.toISOString()
    });

    this.realtimeGateway.emitReservationCreated({
      tenantId,
      reservationId: reservation.id,
      pickupTime: reservation.pickupTime.toISOString()
    });

    await this.operationsService.recordReservationCreatedEvent({
      tenantId,
      reservationId: reservation.id,
      pickupTime: reservation.pickupTime.toISOString()
    });

    return {
      id: reservation.id,
      tenantId: reservation.tenantId,
      customerName: reservation.customerName,
      pickupLocation: reservation.pickupLocation,
      dropoffLocation: reservation.dropoffLocation,
      pickupTime: reservation.pickupTime.toISOString(),
      status: reservation.status as ReservationStatus
    };
  }

  async updateStatus(id: string, dto: UpdateReservationStatusDto): Promise<ReservationEntity> {
    const tenantId = getCurrentTenantId();
    if (!tenantId) {
      throw new UnauthorizedException("Missing tenant context");
    }

    const changedByUserId = getCurrentUserId();

    const reservation = await this.prisma.reservation.findFirst({
      where: {
        id,
        tenantId,
        deletedAt: null
      }
    });

    if (!reservation) {
      throw new NotFoundException("Reservation not found");
    }

    const previousStatus = reservation.status as ReservationStatus;
    const nextStatus = dto.status;

    if (previousStatus === nextStatus) {
      return {
        id: reservation.id,
        tenantId: reservation.tenantId,
        customerName: reservation.customerName,
        pickupLocation: reservation.pickupLocation,
        dropoffLocation: reservation.dropoffLocation,
        pickupTime: reservation.pickupTime.toISOString(),
        status: previousStatus
      };
    }

    if (!ALLOWED_TRANSITIONS[previousStatus].has(nextStatus)) {
      throw new BadRequestException(
        `Invalid status transition from ${previousStatus} to ${nextStatus}`
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedReservation = await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: nextStatus as PrismaReservationStatus
        }
      });

      await tx.reservationStatusLog.create({
        data: {
          tenantId,
          reservationId: reservation.id,
          changedByUserId,
          previousStatus: previousStatus as PrismaReservationStatus,
          newStatus: nextStatus as PrismaReservationStatus,
          reason: dto.reason
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: changedByUserId,
          actionType: "RESERVATION_STATUS_UPDATED",
          moduleName: "ReservationModule",
          entityType: "Reservation",
          entityId: reservation.id,
          oldValue: {
            status: previousStatus
          },
          newValue: {
            status: nextStatus,
            reason: dto.reason ?? null
          }
        }
      });

      return updatedReservation;
    });

    await this.queueService.enqueueReservationStatusUpdated({
      tenantId,
      reservationId: updated.id,
      previousStatus,
      nextStatus,
      reason: dto.reason
    });

    this.realtimeGateway.emitReservationStatusUpdated({
      tenantId,
      reservationId: updated.id,
      previousStatus,
      nextStatus,
      reason: dto.reason
    });

    await this.operationsService.recordReservationStatusUpdatedEvent({
      tenantId,
      reservationId: updated.id,
      previousStatus,
      nextStatus,
      reason: dto.reason
    });

    return {
      id: updated.id,
      tenantId: updated.tenantId,
      customerName: updated.customerName,
      pickupLocation: updated.pickupLocation,
      dropoffLocation: updated.dropoffLocation,
      pickupTime: updated.pickupTime.toISOString(),
      status: updated.status as ReservationStatus
    };
  }
}
