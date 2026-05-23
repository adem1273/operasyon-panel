import { Global, Module } from "@nestjs/common";
import { QueueService } from "./queue.service";
import { QueueWorkerService } from "./queue.worker.service";

@Global()
@Module({
  providers: [QueueService, QueueWorkerService],
  exports: [QueueService]
})
export class QueueModule {}
