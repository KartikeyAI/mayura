import { openrouter } from '../src/index.js';
import { gatewaySuite } from '../../provider-openai/test/gateway-suite.js';
gatewaySuite('openrouter', (fetch, settings = {}) => openrouter({ ...{ apiKey: 'fixture-key' }, ...settings, fetch }), { Authorization: 'Bearer fixture-key' });
