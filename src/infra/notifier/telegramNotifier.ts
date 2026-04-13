import type { Logger } from "pino";

export class TelegramNotifier {
  public constructor(
    private readonly botToken: string | undefined,
    private readonly chatId: string | undefined,
    private readonly logger: Logger
  ) {}

  public async notify(message: string): Promise<void> {
    if (!this.botToken || !this.chatId) {
      this.logger.debug("Telegram notifier skipped because credentials are missing");
      return;
    }

    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message
        })
      });
    } catch (error) {
      this.logger.warn({ error }, "Failed to send Telegram notification");
    }
  }
}
