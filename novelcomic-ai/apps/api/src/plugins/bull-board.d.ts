export interface BullBoardApp {
    get(path: string, handler: () => Promise<{
        queues: string[];
    }>): void;
}
export declare function registerBullBoard(app: BullBoardApp, enabled: boolean): Promise<void>;
