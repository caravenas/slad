import { getProvider } from './src/models/index.js';
import { getApiKey, getModel } from './src/core/config.js';

const apiKey = getApiKey('gemini');
console.log('API Key presente:', !!apiKey);
console.log('Modelo default Gemini:', getModel('gemini'));

const provider = await getProvider('gemini', apiKey ?? 'fake-key-for-test');
console.log('Provider name:', provider.name);
console.log('✓ GeminiProvider instanciado correctamente');
