import { Global, Module } from "@nestjs/common";
import { NotificationService } from "./notification.service";
import { FcmProvider } from "./providers/fcm.provider";
import { WhatsAppProvider } from "./providers/whatsapp.provider";
import { NotificationRecipientResolverService } from "./recipient-resolver.service";

@Global()
@Module({
  providers: [
    NotificationService,
    NotificationRecipientResolverService,
    FcmProvider,
    WhatsAppProvider
  ],
  exports: [NotificationService]
})
export class NotificationModule {}
