import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { OperationsModule } from "../operations/operations.module";
import { MetricsController } from "./metrics.controller";

@Module({
  imports: [OperationsModule],
  controllers: [HealthController, MetricsController]
})
export class HealthModule {}
