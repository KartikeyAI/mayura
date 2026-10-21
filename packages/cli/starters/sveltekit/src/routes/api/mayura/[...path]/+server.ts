import { handle } from '../../../../../server/node.mjs';
import type { RequestHandler } from './$types';
const dispatch: RequestHandler = ({ request }) => handle(request);
export { dispatch as GET, dispatch as POST, dispatch as DELETE, dispatch as OPTIONS, dispatch as HEAD };
