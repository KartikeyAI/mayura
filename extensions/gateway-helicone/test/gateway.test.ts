import { helicone } from '../src/index.js';
import { gatewaySuite } from '../../provider-openai/test/gateway-suite.js';
gatewaySuite('helicone', (fetch, settings = {}) => helicone({ ...{ apiKey: 'fixture-key' }, ...settings, fetch }), { Authorization: 'Bearer fixture-key' });
