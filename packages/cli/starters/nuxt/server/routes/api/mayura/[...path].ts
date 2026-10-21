import { defineEventHandler, toWebRequest, sendWebResponse } from 'h3';
import { handle } from '../../../node.mjs';
export default defineEventHandler(async event => sendWebResponse(event, await handle(toWebRequest(event))));
