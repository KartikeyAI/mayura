import { handle } from '../../server/node.mjs';
export const loader = ({ request }: { request: Request }) => handle(request);
export const action = ({ request }: { request: Request }) => handle(request);
