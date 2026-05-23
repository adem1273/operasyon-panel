import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ReservationService } from "./reservation.service";
import { CreateReservationDto } from "./dto/create-reservation.dto";
import { ReservationStatus } from "./reservation.status";
import { UpdateReservationStatusDto } from "./dto/update-reservation-status.dto";
import { Roles } from "../../common/auth/roles.decorator";
import { UserRole } from "@prisma/client";

type ReservationResponse = {
  id: string;
  tenantId: string;
  customerName: string;
  pickupLocation: string;
  dropoffLocation: string;
  pickupTime: string;
  status: ReservationStatus;
};

@Controller("reservations")
@Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.OPERATOR)
export class ReservationController {
  constructor(private readonly reservationService: ReservationService) {}

  @Get()
  list(): Promise<ReservationResponse[]> {
    return this.reservationService.list();
  }

  @Post()
  create(@Body() dto: CreateReservationDto): Promise<ReservationResponse> {
    return this.reservationService.create(dto);
  }

  @Patch(":id/status")
  updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateReservationStatusDto
  ): Promise<ReservationResponse> {
    return this.reservationService.updateStatus(id, dto);
  }
}
