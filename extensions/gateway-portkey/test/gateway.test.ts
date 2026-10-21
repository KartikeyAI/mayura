import { portkey } from '../src/index.js';
import { gatewaySuite } from '../../provider-openai/test/gateway-suite.js';
gatewaySuite('portkey', (fetch, settings = {}) => portkey({ ...{ apiKey: 'fixture-key', provider: '@openai' }, ...settings, fetch }), { 'x-portkey-api-key': 'fixture-key', 'x-portkey-provider': '@openai' });
