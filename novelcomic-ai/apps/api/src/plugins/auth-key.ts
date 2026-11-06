export interface AuthKeyHookConfig {
  security: {
    authKey: string;
  };
}

interface AuthKeyRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  log: {
    warn(fields: Record<string, unknown>, message?: string): void;
  };
}

interface AuthKeyReply {
  code(statusCode: number): {
    send(payload: unknown): unknown;
  };
}

interface AuthKeyApp {
  addHook(
    name: 'preHandler',
    handler: (request: AuthKeyRequest, reply: AuthKeyReply) => Promise<unknown>,
  ): void;
}

export function registerAuthKeyHook(app: AuthKeyApp, config: AuthKeyHookConfig): void {
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/')) {
      return;
    }
    if (url.startsWith('/v1/provider-webhooks/')) {
      return;
    }

    const headerAuthKey = readHeaderValue(request.headers.auth_key);
    if (!config.security.authKey || headerAuthKey !== config.security.authKey) {
      request.log.warn(
        {
          event: 'task.api.auth_failed',
          method: request.method,
          url: request.url,
          has_auth_key_header: Boolean(headerAuthKey),
          user_agent: request.headers['user-agent'],
        },
        'task.api.auth_failed',
      );
      return reply.code(401).send({ code: 401, msg: 'Unauthorized', data: null });
    }
  });
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
