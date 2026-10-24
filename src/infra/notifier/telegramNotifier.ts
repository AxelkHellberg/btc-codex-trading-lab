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
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message
        })
      });
      // Delivery needs only the status; discard the body without delaying the caller.
      void response.body?.cancel().catch(() => {});
      if (!response.ok) {
        this.logger.warn({ status: response.status }, "Telegram notification rejected");
      }
    } catch (error) {
      // Fetch errors can include the credential-bearing URL. Retain only the class.
      this.logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Failed to send Telegram notification"
      );
    }
  }
}
