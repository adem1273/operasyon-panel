import { Module } from "@nestjs/common";
import { ReservationController } from "./reservation.controller";
import { ReservationService } from "./reservation.service";
import { OperationsModule } from "../operations/operations.module";

@Module({
  imports: [OperationsModule],
  controllers: [ReservationController],
  providers: [ReservationService]
})
export class ReservationModule {}
