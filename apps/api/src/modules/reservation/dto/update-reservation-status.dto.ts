import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { ReservationStatus } from "../reservation.status";

export class UpdateReservationStatusDto {
  @IsEnum(ReservationStatus)
  status!: ReservationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
