export interface BullBoardApp {
  get(path: string, handler: () => Promise<{ queues: string[] }>): void;
}

export async function registerBullBoard(app: BullBoardApp, enabled: boolean): Promise<void> {
  if (!enabled) {
    return;
  }

  app.get('/admin/queues', async () => ({ queues: [] }));
}
