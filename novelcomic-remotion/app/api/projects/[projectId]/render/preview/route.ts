import {POST as createRender} from '../route';
export const runtime = 'nodejs';
export async function POST(request: Request, context: {params: Promise<{projectId: string}>}) { const body = await request.json(); return createRender(new Request(request.url, {method: 'POST', headers: request.headers, body: JSON.stringify({...body, kind: 'preview'})}), context); }
