import { Controller, Get } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";

@Controller("health")
@Public()
export class HealthController {
  @Get()
  status(): { ok: boolean; service: string; timestamp: string } {
    return {
      ok: true,
      service: "vipflow-api",
      timestamp: new Date().toISOString()
    };
  }
}
