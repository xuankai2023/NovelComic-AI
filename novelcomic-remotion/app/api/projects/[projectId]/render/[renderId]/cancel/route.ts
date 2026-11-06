import {DELETE as cancelRender} from '../route';
export const runtime = 'nodejs';
export async function POST(request: Request, context: {params: Promise<{projectId: string; renderId: string}>}) { return cancelRender(request, context); }
