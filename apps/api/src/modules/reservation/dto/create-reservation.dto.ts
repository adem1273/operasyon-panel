import { IsISO8601, IsString, MinLength } from "class-validator";

export class CreateReservationDto {
  @IsString()
  @MinLength(2)
  customerName!: string;

  @IsString()
  @MinLength(2)
  pickupLocation!: string;

  @IsString()
  @MinLength(2)
  dropoffLocation!: string;

  @IsISO8601()
  pickupTime!: string;
}
