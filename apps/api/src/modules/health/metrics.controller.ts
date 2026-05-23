import { Controller, Get, Res } from "@nestjs/common";
import { Response } from "express";
import { Public } from "../../common/auth/public.decorator";
import { OperationsService } from "../operations/operations.service";

@Controller()
@Public()
export class MetricsController {
  constructor(private readonly operationsService: OperationsService) {}

  @Get("metrics")
  metrics(@Res({ passthrough: true }) response: Response): string {
    response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return this.operationsService.getPrometheusMetrics();
  }
}
