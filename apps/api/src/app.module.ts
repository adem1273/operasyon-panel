import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { ReservationModule } from "./modules/reservation/reservation.module";
import { TenantContextMiddleware } from "./common/middleware/tenant-context.middleware";
import { PrismaModule } from "./common/prisma/prisma.module";
import { QueueModule } from "./common/queue/queue.module";
import { AccessTokenGuard } from "./common/auth/access-token.guard";
import { RolesGuard } from "./common/auth/roles.guard";
import { OperationsModule } from "./modules/operations/operations.module";
import { RealtimeModule } from "./common/realtime/realtime.module";
import { NotificationModule } from "./modules/notification/notification.module";

@Module({
  imports: [
    PrismaModule,
    QueueModule,
    RealtimeModule,
    NotificationModule,
    HealthModule,
    AuthModule,
    ReservationModule,
    OperationsModule
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AccessTokenGuard
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard
    }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes("*");
  }
}
