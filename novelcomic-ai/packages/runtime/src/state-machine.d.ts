import type { AiTaskStatus } from '@novelcomic/contracts';
export declare class TaskStatusTransitionError extends Error {
    readonly from: AiTaskStatus;
    readonly to: AiTaskStatus;
    readonly code = "TASK_STATUS_TRANSITION_INVALID";
    constructor(from: AiTaskStatus, to: AiTaskStatus);
}
export declare function isTerminalStatus(status: AiTaskStatus): boolean;
export declare function assertTaskStatusCanAdvance(from: AiTaskStatus, to: AiTaskStatus): void;
