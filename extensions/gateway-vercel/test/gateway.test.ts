import { vercelGateway } from '../src/index.js';
import { gatewaySuite } from '../../provider-openai/test/gateway-suite.js';
gatewaySuite('vercel', (fetch, settings = {}) => vercelGateway({ ...{ apiKey: 'fixture-key' }, ...settings, fetch }), { Authorization: 'Bearer fixture-key' });
