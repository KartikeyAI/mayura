import { createFileRoute } from '@tanstack/react-router';
import { handle } from '../../server/node.mjs';
const dispatch = ({ request }: { request: Request }) => handle(request);
export const Route = createFileRoute('/api/mayura/$')({ server: { handlers: { GET: dispatch, POST: dispatch, DELETE: dispatch, OPTIONS: dispatch, HEAD: dispatch } } });
