import { CreateAiTaskRequestSchema } from '@novelcomic/contracts';
import { CallbackDeliveryRepository, ProviderEventRepository, TaskRepository } from '@novelcomic/db';
import type { logger as apiLogger } from '@novelcomic/observability';
import { TaskService, TaskServiceValidationError, type TaskSubmitQueue } from '@novelcomic/runtime';
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Db } from 'mongodb';

type ApiFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  typeof apiLogger
>;

export interface RegisterTaskRoutesOptions {
  db: Db;
  providerExecutionQueue: TaskSubmitQueue;
}

export async function registerTaskRoutes(
  app: ApiFastifyInstance,
  options: RegisterTaskRoutesOptions,
): Promise<void> {
  const taskRepository = new TaskRepository(options.db);
  await taskRepository.ensureIndexes();

  const taskService = new TaskService(taskRepository, options.providerExecutionQueue);

  app.post('/v1/tasks', async (request, reply) => {
    const parsed = CreateAiTaskRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        code: 400,
        msg: 'Invalid request body',
        data: { details: parsed.error.flatten() },
      });
    }

    try {
      const response = await taskService.createTask(parsed.data);
      if (response.status === 'existing') {
        return reply.code(200).send({ ...response, existing: true });
      }

      return reply.code(202).send(response);
    } catch (error) {
      if (error instanceof TaskServiceValidationError) {
        return reply.code(400).send({
          code: 400,
          msg: error.message,
          data: error.validation,
        });
      }

      throw error;
    }
  });

  app.get<{ Params: { ai_task_id: string } }>('/v1/tasks/:ai_task_id', async (request, reply) => {
    const aiTaskId = request.params.ai_task_id?.trim();
    if (!aiTaskId) {
      return reply.code(400).send({
        code: 400,
        msg: 'ai_task_id is required',
        data: null,
      });
    }

    const task = await taskRepository.getById(aiTaskId);
    if (!task) {
      return reply.code(404).send({
        code: 404,
        msg: 'Task not found',
        data: null,
      });
    }

    let providerEvents: unknown[] = [];
    let callbackDeliveries: unknown[] = [];
    try {
      const providerEventRepository = new ProviderEventRepository(options.db);
      providerEvents = await providerEventRepository.listByTask(aiTaskId);
    } catch {
      providerEvents = [];
    }
    try {
      const callbackDeliveryRepository = new CallbackDeliveryRepository(options.db);
      callbackDeliveries = await callbackDeliveryRepository.listByTask(aiTaskId);
    } catch {
      callbackDeliveries = [];
    }

    return reply.code(200).send({
      code: 200,
      msg: 'ok',
      data: {
        task,
        attempts: [],
        provider_events: providerEvents,
        callback_deliveries: callbackDeliveries,
      },
    });
  });
}
